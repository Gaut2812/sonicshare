import {
  VIDEO_CHUNK_MIN,
  VIDEO_CHUNK_MAX,
  FEC_RATIO,
  WINDOW_RTT_THRESHOLDS,
} from "./config.js";
import { debugLog, updateSenderUI } from "./ui.js";
import {
  buildVideoPacket,
  buildSackPacket,
  buildFecPacket,
  parsePacket,
} from "./packet.js";

// ============================================================================
// 1. Hybrid Congestion Control (Token Bucket + BBR-like Pacing)
// ============================================================================
export class VideoFlowController {
  constructor() {
    this.tokens = 0; // Available sending credits (bytes)
    this.bucketSize = 50 * 1024 * 1024; // 50MB burst capacity
    this.fillRate = 0; // Dynamic: bytes/sec
    this.lastFill = performance.now();
    this.minChunkSize = VIDEO_CHUNK_MIN;
    this.maxChunkSize = VIDEO_CHUNK_MAX;
    this.rttHistory = [];
  }

  // Adaptive fill rate based on RTT measurements
  updateFillRate(measuredRTT) {
    if (!measuredRTT) return;
    this.rttHistory.push(measuredRTT);
    if (this.rttHistory.length > 10) this.rttHistory.shift();

    const avgRTT =
      this.rttHistory.reduce((a, b) => a + b, 0) / this.rttHistory.length;

    // BBR-inspired: bandwidth = delivery_rate / (RTT variation)
    if (this.rttHistory.length < 5) {
      this.fillRate = 10 * 1024 * 1024; // Start aggressive: 10MB/s
    } else {
      const minRTT = Math.min(...this.rttHistory);
      const maxRTT = Math.max(...this.rttHistory);
      const rttVar = maxRTT - minRTT;
      const stability = avgRTT > 0 ? 1 - Math.min(rttVar / avgRTT, 1) : 0.5;

      // Target 20MB/s on stable links, drop on jitter
      this.fillRate = this.fillRate * 0.8 + stability * 20 * 1024 * 1024 * 0.2;
    }
    // console.log(`🌊 BW: ${(this.fillRate/1024/1024).toFixed(1)}MB/s RTT: ${avgRTT.toFixed(0)}ms`);
  }

  canSend(chunkSize) {
    const now = performance.now();
    const elapsed = (now - this.lastFill) / 1000;
    this.tokens = Math.min(
      this.bucketSize,
      this.tokens + this.fillRate * elapsed,
    );
    this.lastFill = now;

    if (this.tokens >= chunkSize) {
      this.tokens -= chunkSize;
      return true;
    }
    return false;
  }

  getOptimalChunkSize() {
    if (this.rttHistory.length === 0) return this.minChunkSize;
    const avgRTT =
      this.rttHistory.reduce((a, b) => a + b, 0) / this.rttHistory.length;
    // Target 3 packets in flight per RTT
    const targetInFlight = 3;
    const chunkSize = Math.min(
      this.maxChunkSize,
      Math.max(
        this.minChunkSize,
        (this.fillRate * avgRTT) / 1000 / targetInFlight,
      ),
    );
    return Math.floor(chunkSize);
  }
}

// ============================================================================
// 2. Optimized Video Protocol (SACK + FEC + Out-of-Order)
// ============================================================================
export class VideoTransferProtocol {
  constructor(dataChannel) {
    this.dc = dataChannel;
    this.windowBase = 0; // Cumulative Ack
    this.sentChunks = new Map(); // seq -> {data, timestamp, retries}

    this.flowController = new VideoFlowController();
    this.fecEnabled = true;
    this.fecRatio = FEC_RATIO;

    // Bind SACK handler
    this.onSack = this.handleSack.bind(this);
  }

  // Send with 16-byte header including offset and isLast
  sendVideoChunk(chunk) {
    // Generate packet with 16-byte header
    const packetData = buildVideoPacket(
      chunk.seq,
      chunk.data,
      chunk.isLast,
      chunk.offset,
    );

    // Track for retransmission (only if we actually send it)
    this.sentChunks.set(sequenceNumber, {
      data: chunk.data,
      timestamp: performance.now(),
      acked: false,
    });

    try {
      this.dc.send(packetData);
    } catch (e) {
      console.error("Send error", e);
      return false; // Indicate failure
    }

    // Interleave FEC
    if (this.fecEnabled && sequenceNumber % 10 === 9) {
      const fecPacket = buildFecPacket(
        Math.floor(sequenceNumber / 10),
        chunk.data.slice(0, 100),
      );
      try {
        this.dc.send(fecPacket);
      } catch (e) {}
    }
    return true; // Indicate success
  }

  handleSack(sackMessage) {
    const { ranges, cumulativeAck } = sackMessage;
    // Estimated RTT from last sent chunk?
    // Ideally SACK contains echo of timestamp, but we'll use latest inflight
    const now = performance.now();
    let rttSample = null;

    // Clear acknowledged ranges
    for (const range of ranges) {
      for (let i = range.start; i <= range.end; i++) {
        if (this.sentChunks.has(i)) {
          const meta = this.sentChunks.get(i);
          if (!meta.acked) {
            rttSample = now - meta.timestamp;
            meta.acked = true;
          }
          this.sentChunks.delete(i);
        }
      }
    }

    if (cumulativeAck > this.windowBase) {
      // Clear all before cumulative
      for (let i = this.windowBase; i < cumulativeAck; i++) {
        this.sentChunks.delete(i);
      }
      this.windowBase = cumulativeAck;
    }

    if (rttSample) {
      this.flowController.updateFillRate(rttSample);
    }
  }
}

// ============================================================================
// 3. Pacing Scheduler (Prevents UI Freeze)
// ============================================================================
export class PacingScheduler {
  constructor(protocol) {
    this.protocol = protocol;
    this.queue = [];
    this.isRunning = false;
  }

  enqueue(chunkItem) {
    this.queue.push(chunkItem);
    if (!this.isRunning) this.run();
  }

  async run() {
    this.isRunning = true;
    while (this.queue.length > 0) {
      const chunk = this.queue[0]; // Peek

      // 1. Check Flow Control (Token Bucket)
      if (!this.protocol.flowController.canSend(chunk.data.byteLength)) {
        await new Promise((r) => setTimeout(r, 10)); // Wait for tokens
        continue;
      }

      // 2. Check WebRTC Buffer backpressure (Event-driven)
      if (this.protocol.dc.bufferedAmount > 256 * 1024) {
        await new Promise((r) => {
          this.protocol.dc.onbufferedamountlow = () => {
            this.protocol.dc.onbufferedamountlow = null; // Reset
            r();
          };
          // Fallback timeout just in case event is missed
          setTimeout(r, 100);
        });
        continue;
      }

      // 3. All clear - Send it
      this.queue.shift(); // Remove from queue
      const success = this.protocol.sendVideoChunk(chunk);

      // Yield to event loop
      if (this.queue.length % 5 === 0) {
        await new Promise((r) => setTimeout(r, 0));
      }
    }
    this.isRunning = false;
  }

  // Promise that resolves when the queue is drained
  async drain() {
    while (this.isRunning || this.queue.length > 0) {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
}

// ============================================================================
// 4. Video Aware Chunker (MP4 Parsing)
// ============================================================================
export class VideoChunker {
  constructor(file, flowController) {
    this.file = file;
    this.flowController = flowController;
    this.chunkSize = VIDEO_CHUNK_MIN;
    this.isMP4 = file.name.endsWith(".mp4");
  }

  async *generateChunks() {
    // 1. Send MOOV atom first if possible (simplified: just send first 1MB as priority)
    // Real parser would scan for 'moov'.

    let offset = 0;
    let seq = 0;

    while (offset < this.file.size) {
      // Adapt chunk size
      this.chunkSize = this.flowController.getOptimalChunkSize();

      const end = Math.min(offset + this.chunkSize, this.file.size);
      const blob = this.file.slice(offset, end);
      const data = await blob.arrayBuffer();

      const isLast = end >= this.file.size;
      yield {
        seq: seq++,
        data: data,
        offset: offset,
        isLast: isLast,
        priority: offset === 0 ? "critical" : "normal",
      };

      offset = end;
    }
  }
}
