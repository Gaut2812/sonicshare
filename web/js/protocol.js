import { state } from "./state.js";
import { updateSenderUI, updateReceiverUI, debugLog } from "./ui.js";
import {
  CHUNK_SIZE,
  WINDOW_SIZE,
  MAX_BUFFER,
  IS_SECURE,
  RETRANSMIT_INTERVAL,
  MAX_RETRIES,
  PREFETCH_CHUNKS,
  WINDOW_RTT_THRESHOLDS,
} from "./config.js";
import {
  generateKeys,
  getPublicKeyB64,
  importPeerKey,
  deriveSharedKey,
  decryptChunk,
  encryptChunk,
  computeHash,
  initStreamingHash,
  updateStreamingHash,
  finalizeStreamingHash,
} from "./crypto.js";
import { saveChunkToDB, clearDB, getAllChunksFromDB } from "./db.js";
import {
  startWebRTC,
  handleOffer,
  handleAnswer,
  handleCandidate,
  canSendOnWebRTC,
  sendBinaryData,
} from "./webrtc.js";
import { sendData } from "./network.js";
import {
  buildDataPacket,
  buildAckPacket,
  buildSackPacket,
  parsePacket,
  PacketType,
  isBinaryPacket,
} from "./packet.js";
import {
  VideoTransferProtocol,
  VideoChunker,
  PacingScheduler,
} from "./video_engine.js";

// =============================================================================
// BBR-Style Pacer (Bottleneck Bandwidth and RTT Pacing)
// =============================================================================
class BBRS_Pacer {
  constructor() {
    this.lastSentTime = performance.now();
  }

  // Calculate sleep time to maintain pacingRate
  async pace(chunkSize) {
    const now = performance.now();
    const duration = (chunkSize / state.pacingRate) * 1000;
    const nextSendTime = this.lastSentTime + duration;
    const sleep = Math.max(0, nextSendTime - now);
    
    if (sleep > 0) {
      await new Promise(r => setTimeout(r, sleep));
      this.lastSentTime = performance.now();
    } else {
      this.lastSentTime = now;
    }
  }

  // Update bandwidth estimation from ACK
  updateBW(deliveredBytes, ackTime, rtt) {
    if (rtt < state.minRTT) state.minRTT = rtt;

    const deltaBytes = deliveredBytes - state.deliveredBytes;
    const deltaTime = (ackTime - state.lastAckTime) / 1000;

    if (deltaTime > 0) {
      const currentBW = deltaBytes / deltaTime;
      state.bwWindow.push(currentBW);
      if (state.bwWindow.length > 10) state.bwWindow.shift();

      const maxBW = state.bwWindow.length > 0 ? Math.max(...state.bwWindow) : state.pacingRate / state.pacingGain;
      state.pacingRate = maxBW * state.pacingGain;
      
      // Clamp pacing rate to sane values: 1MB/s minimum, 100MB/s maximum
      state.pacingRate = Math.max(1024 * 1024, Math.min(state.pacingRate, 100 * 1024 * 1024));
    }

    state.deliveredBytes = deliveredBytes;
    state.lastAckTime = ackTime;
  }
}

const pacer = new BBRS_Pacer();

// 🔄 SMART RETRANSMISSION: Selective Retransmit with Exponential Backoff
setInterval(async () => {
  if (state.transferState !== "READY" || !state.isTransferring) return;

  // ⚡ VIDEO MODE: Disable retransmission logic (Step 1)
  if (state.isVideoStream) return;

  const now = Date.now();

  for (let seq in state.inflight) {
    const seqNum = Number(seq);

    // Initial tracking
    if (!state.chunkRetries[seqNum]) state.chunkRetries[seqNum] = 0;
    if (!state.lastSentTime[seqNum]) state.lastSentTime[seqNum] = now;

    // Exponential Backoff: Wait longer if it keeps failing (3s, 6s, 12s... max 30s)
    const backoffMult = Math.min(Math.pow(2, state.chunkRetries[seqNum]), 10);
    const timeout = RETRANSMIT_INTERVAL * backoffMult;

    if (now - state.lastSentTime[seqNum] < timeout) continue;

    state.chunkRetries[seqNum]++;
    state.lastSentTime[seqNum] = now;

    if (state.chunkRetries[seqNum] > MAX_RETRIES) {
      // ⚡ PRODUCTION LOGIC: On long transfers, don't just "fail".
      // Scale back throughput and warn the user.
      if (state.chunkRetries[seqNum] % 5 === 0) {
        debugLog(
          `⚠️ Connection very unstable. Persistent retry for chunk ${seqNum}...`,
          "var(--error)",
        );
        console.warn(
          `Chunk ${seqNum} has failed ${state.chunkRetries[seqNum]} times. Exponential backoff active.`,
        );
      }
      // If we hit a massive retry count (e.g. 50), then it's a dead connection.
      if (state.chunkRetries[seqNum] > 50) {
        state.isTransferring = false;
        debugLog("❌ Connection lost. Peer unresponsive.", "var(--error)");
        return;
      }
    }

    console.log(
      `🔄 Retrying chunk ${seqNum} (Attempt ${state.chunkRetries[seqNum]})`,
    );

    // Prepare data
    const encrypted = await encryptChunk(state.inflight[seq]);

    // ⚡ SMART FALLBACK: If a chunk fails too many times, P2P might be a "ghost" connection.
    // Force switch to Relay to unblock the transfer.
    let forceRelay = false;
    if (state.chunkRetries[seqNum] > 5) {
      if (state._usingP2P) {
        debugLog(
          "⚠️ P2P unstable. Forcing Relay for this chunk.",
          "var(--aa00)",
        );
        console.warn("Forcing Relay due to high retries");
      }
      forceRelay = true;
    }

    // ⚡ USE BINARY PATH FOR RETRY IF POSSIBLE
    const useWebRTC =
      !forceRelay &&
      state.dataChannel &&
      state.dataChannel.readyState === "open";

    if (useWebRTC) {
      const binaryPacket = buildDataPacket(
        seqNum,
        encrypted.iv,
        encrypted.data,
      );
      sendBinaryData(binaryPacket);
    } else if (state.ws && state.ws.readyState === WebSocket.OPEN) {
      // Use raw binary over WSS if P2P is down OR forced off
      const binaryPacket = buildDataPacket(
        seqNum,
        encrypted.iv,
        encrypted.data,
      );
      try {
        state.ws.send(binaryPacket);
      } catch (e) {}
    }
  }
}, 1000); // Check every second for expired timeouts

// ============================================================================
// PRODUCTION-LEVEL WEBRTC OPTIMIZATIONS
// ============================================================================

/**
 * Calculate average RTT and adjust window size dynamically
 * ⚡ CRITICAL: Low RTT = increase window, High RTT = decrease window
 */
function updateDynamicWindow() {
  if (state.rttSamples.length < 5) return; // Need enough samples

  // Keep only last 20 samples for rolling average
  if (state.rttSamples.length > 20) {
    state.rttSamples = state.rttSamples.slice(-20);
  }

  const avgRTT =
    state.rttSamples.reduce((a, b) => a + b, 0) / state.rttSamples.length;

  // Adjust window size based on RTT
  let newWindow = WINDOW_SIZE;
  for (const [key, config] of Object.entries(WINDOW_RTT_THRESHOLDS)) {
    if (avgRTT < config.rtt) {
      newWindow = config.window;
      break;
    }
  }

  if (newWindow !== state.dynamicWindowSize) {
    console.log(
      `📊 RTT: ${avgRTT.toFixed(1)}ms → Window: ${state.dynamicWindowSize} → ${newWindow}`,
    );
    state.dynamicWindowSize = newWindow;
  }
}

// Binary packet handling is now delegated to SonicReceiver.js
export async function handleBinaryPacket(data) {
  // Empty or minimal implementation for backwards compatibility if needed
  console.log(
    "Binary packet received on protocol.js (ignored, handled by receiver.js)",
  );
}

/**
 * Prefetch file chunks for parallel reading
 * ⚡ Keeps CPU busy while network is sending
 */
async function prefetchChunks() {
  if (!state.currentFile || !state.isTransferring) return;

  const totalChunks = Math.ceil(state.currentFile.size / CHUNK_SIZE);

  // Fill prefetch queue
  while (
    state.prefetchQueue.length < PREFETCH_CHUNKS &&
    state.nextSeq + state.prefetchQueue.length < totalChunks
  ) {
    const seqToPrefetch = state.nextSeq + state.prefetchQueue.length;
    const offset = seqToPrefetch * CHUNK_SIZE;
    const slice = state.currentFile.slice(offset, offset + CHUNK_SIZE);

    // Read asynchronously
    const arrayBuffer = await slice.arrayBuffer();

    state.prefetchQueue.push({
      seq: seqToPrefetch,
      data: arrayBuffer,
    });
  }
}

/**
 * Get next chunk from prefetch queue or read directly
 * @returns {Promise<{seq: number, data: ArrayBuffer}>}
 */
async function getNextChunk() {
  // Try prefetch queue first
  if (state.prefetchQueue.length > 0) {
    return state.prefetchQueue.shift();
  }

  // Fall back to direct read
  const offset = state.nextSeq * CHUNK_SIZE;
  const slice = state.currentFile.slice(offset, offset + CHUNK_SIZE);
  const arrayBuffer = await slice.arrayBuffer();

  return {
    seq: state.nextSeq,
    data: arrayBuffer,
  };
}

// ============================================================================

export async function sendFile(file) {
  state.currentFile = file;
  if (state.transferState === "READY") {
    await startTransfer();
  } else {
    const statusEl = document.getElementById("status");
    if (statusEl) {
      statusEl.innerText = "File ready. Waiting for receiver to connect...";
      statusEl.style.color = "var(--text-secondary)";
    }
  }
}

async function startTransfer() {
  if (!state.currentFile || state.transferState !== "READY") return;
  const totalChunks = Math.ceil(state.currentFile.size / CHUNK_SIZE);
  console.log("Starting Transfer. Total chunks:", totalChunks);

  // New METADATA format for Sonic Protocol Spec
  import("./network.js").then((m) =>
    m.sendData({
      type: "file_info",
      file_name: state.currentFile.name,
      file_size: state.currentFile.size,
      total_chunks: totalChunks,
      chunk_size: state.currentChunkSize,
    }),
  );

  state.resetTransfer();

  // Initialize streaming hash for memory-safe large file hashing
  initStreamingHash();

  const container = document.getElementById("progress-container");
  if (container) container.style.display = "block";

  // Wait for START_TRANSFER or RESUME_FROM from receiver
}

// Export for WebRTC bufferedamountlow callback
export const trySendWebRTC = trySend;

async function trySend() {
  if (!state.currentFile || !state.isTransferring || state.isSending) return;
  state.isSending = true;

  const dataChannels = (
    state.dataChannels.length > 0 ? state.dataChannels : [state.dataChannel]
  ).filter((dc) => dc && dc.readyState === "open");
  const dataChannel = state.dataChannel;

  if (
    dataChannels.length === 0 &&
    (!dataChannel || dataChannel.readyState !== "open")
  ) {
    console.error("❌ No DataChannels ready");
    state.isSending = false;
    return;
  }

  const { buildSonicPacket } = await import("./packet.js");

  while (state.fileOffset < state.currentFile.size && state.isTransferring) {
    // Find the least-loaded open channel via round-robin
    // Advance index only once per successful send
    let attempts = 0;
    let currentDC = null;

    while (attempts < dataChannels.length) {
      const idx = (state.activeChannelIndex + attempts) % dataChannels.length;
      const candidate = dataChannels[idx];
      if (
        candidate &&
        candidate.readyState === "open" &&
        candidate.bufferedAmount < MAX_BUFFER
      ) {
        currentDC = candidate;
        state.activeChannelIndex = (idx + 1) % dataChannels.length;
        break;
      }
      attempts++;
    }

    // All channels are full or buffer limit reached (Sonic Protocol Spec: 4MB)
    if (!currentDC) {
      await new Promise((resolve) => {
        let resolved = false;
        dataChannels.forEach((dc) => {
          if (dc && dc.readyState === "open") {
            dc.onbufferedamountlow = () => {
              dc.onbufferedamountlow = null;
              if (!resolved) {
                resolved = true;
                resolve();
              }
            };
          }
        });
      });
      continue;
    }

    const offset = state.fileOffset; // Track real offset as chunks are now variable size
    const slice = state.currentFile.slice(
      offset,
      offset + state.currentChunkSize,
    );
    let chunk = await slice.arrayBuffer();

    // Encryption
    let isEncrypted = false;
    const { IS_SECURE } = await import("./config.js");
    if (IS_SECURE && state.sharedKey && state.sharedKey !== "INSECURE") {
      const { encryptChunk } = await import("./crypto.js");

      // Create deterministic 12-byte IV from sequence number
      const customIv = new Uint8Array(12);
      const ivView = new DataView(customIv.buffer);
      ivView.setUint32(8, state.nextSeq, false); // Use last 4 bytes for seq

      const encrypted = await encryptChunk(chunk, customIv);
      chunk = encrypted.data;
      isEncrypted = true;
    }

    const isLast =
      state.fileOffset + chunk.byteLength >= state.currentFile.size;
    const packet = buildSonicPacket(
      state.nextSeq,
      chunk,
      isLast,
      offset,
      isEncrypted,
    );

    try {
      if (currentDC.readyState !== "open") break;
      if (currentDC.bufferedAmount > MAX_BUFFER) {
        await new Promise((r) => setTimeout(r, 10));
        continue;
      }

      state.chunkSendTimes[state.nextSeq] = performance.now();
      currentDC.send(packet);
      
      // Give browser event loop time to breathe
      await pacer.pace(chunk.byteLength);

      state.nextSeq++;
      state.fileOffset += chunk.byteLength;
      state.totalBytesTransferred += chunk.byteLength;

      if (state.nextSeq % 4 === 0) {
        const percent = Math.round(
          (state.fileOffset / state.currentFile.size) * 100,
        );
        const now = Date.now();
        const duration = (now - state.transferStartTime) / 1000;
        const kbps = (state.totalBytesTransferred / duration / 1024).toFixed(1);
        const mbps = (kbps / 1024).toFixed(2);
        
        // Calculate ETA
        const remainingBytes = state.currentFile.size - state.fileOffset;
        const speedBps = state.totalBytesTransferred / duration;
        const etaSeconds = speedBps > 0 ? Math.round(remainingBytes / speedBps) : 0;
        const etaStr = etaSeconds > 60 
          ? `${Math.floor(etaSeconds / 60)}m ${etaSeconds % 60}s` 
          : `${etaSeconds}s`;

        updateSenderUI(percent, `${mbps} MB/s | ETA: ${etaStr}`);
        await new Promise((r) => setTimeout(r, 0));
      }
    } catch (e) {
      console.error("Send failed:", e);
      break;
    }
  }

  if (state.fileOffset >= state.currentFile.size) {
    console.log("✅ Transfer Sent (Awaiting Final ACKs)");
    state.isSending = false;
  } else {
    state.isSending = false;
  }
}

export async function handleMessage(msg) {
  if (msg.type === "OFFER") await handleOffer(msg.payload);
  if (msg.type === "ANSWER") await handleAnswer(msg.payload);
  if (msg.type === "ICE") await handleCandidate(msg.payload);

  const statusEl = document.getElementById("status");

  if (msg.type === "CODE") {
    state.transferState = "WAITING";
    state.sessionCode = msg.code;
    if (document.getElementById("invite-code"))
      document.getElementById("invite-code").innerText = msg.code;
    if (statusEl) {
      statusEl.innerText = "Waiting for receiver...";
      statusEl.style.color = "var(--text-secondary)";
    }
  }

  if (msg.type === "READY") {
    if (state.transferState === "READY") return;
    state.transferState = "READY";
    debugLog(`READY received - Initializing handshake`, "var(--accent)");

    // Only sender needs to generate and send key here
    if (state.isInitiator) {
      await generateKeys();
      const pubKey = await getPublicKeyB64();
      import("./network.js").then((m) =>
        m.sendData({
          type: "KEY",
          code: state.sessionCode,
          payload: pubKey,
        }),
      );
      debugLog("Public key sent", "var(--accent)");
    }
  }

  if (msg.type === "KEY") {
    if (state.sharedKey) return; // Idempotent
    try {
      debugLog("Processing peer key...", "var(--accent)");
      const peerKey = await importPeerKey(msg.payload);
      await deriveSharedKey(peerKey);

      // If we are sender and connection is ready, send the file metadata
      if (state.isInitiator && state.selectedFile) {
        await sendFile(state.selectedFile);
      }
    } catch (e) {
      console.error(e);
    }
  }

  if (msg.type === "START_TRANSFER") {
    state.isTransferring = true;
    trySend();
  }

  if (msg.type === "RESUME_FROM") {
    console.log("♻️ RESUME FROM", msg.byteOffset);
    state.isTransferring = true;
    state.nextSeq = Math.floor(msg.byteOffset / CHUNK_SIZE);
    trySend();
  }

  // Individual ACKs disabled for speed (batch only)

  if (msg.type === "chunk_ack") {
    // Update BBR Pacer with delivery feedback
    const ackedChunks = msg.last_received_chunk + 1;
    const totalDelivered = ackedChunks * CHUNK_SIZE;
    const now = performance.now();
    
    // Estimate RTT if we have send times
    let rtt = 100; // default
    if (state.chunkSendTimes[msg.last_received_chunk]) {
      rtt = now - state.chunkSendTimes[msg.last_received_chunk];
    }
    
    pacer.updateBW(totalDelivered, now, rtt);

    if (msg.last_received_chunk >= Math.ceil(state.currentFile.size / CHUNK_SIZE) - 1) {
      updateSenderUI(100, "Transfer Complete!");
      state.isTransferring = false;
    }
  }

  if (msg.type === "RETRANSMIT_REQUEST") {
    const seqs = msg.sequences || [];
    console.log("🔄 Retransmitting requested chunks (on-demand read):", seqs);
    for (const seq of seqs) {
      const offset = seq * CHUNK_SIZE;
      const slice = state.currentFile.slice(offset, offset + CHUNK_SIZE);
      const chunk = await slice.arrayBuffer();

      const { buildSonicPacket } = await import("./packet.js");
      const isLast = seq === Math.ceil(state.currentFile.size / CHUNK_SIZE) - 1;
      const packet = buildSonicPacket(seq, chunk, isLast, offset, false);

      if (state.dataChannel && state.dataChannel.readyState === "open") {
        state.dataChannel.send(packet);
      }
    }
  }

  if (msg.type === "ERROR") {
    if (statusEl) {
      statusEl.style.color = "var(--error)";
      statusEl.innerText = `❌ Error: ${msg.message || msg.msg}`;
    }
  }
}
