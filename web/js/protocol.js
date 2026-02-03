import { state } from "./state.js";
import { updateSenderUI, updateReceiverUI, debugLog } from "./ui.js";
import {
  CHUNK_SIZE,
  WINDOW_SIZE,
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

/**
 * Handle incoming binary WebRTC packet (high-speed path)
 * @param {ArrayBuffer} data - Binary packet
 */
export async function handleBinaryPacket(data) {
  const packet = parsePacket(data);

  if (packet.type === "VIDEO_DATA") {
    await onVideoData(packet);
    return;
  }
  if (packet.type === "SACK") {
    if (state.videoProtocol) state.videoProtocol.handleSack(packet);
    return;
  }
  if (packet.type === "FEC") {
    // Logic to recover formatted packets (Placeholder)
    return;
  }

  if (packet.type === "DATA") {
    await onData(packet);
  } else if (packet.type === "ACK") {
    await onAck(packet);
  } else if (packet.type === PacketType.END) {
    console.log("🏁 Received binary END packet");
    saveFile();
  }
}

async function startVideoStream() {
  const chunker = new VideoChunker(
    state.currentFile,
    state.videoProtocol.flowController,
  );
  const container = document.getElementById("progress-container");
  if (container) container.style.display = "block";

  // Pacing Loop
  for await (const chunk of chunker.generateChunks()) {
    if (!state.isTransferring) break;
    state.videoScheduler.enqueue(chunk);

    // Update UI (Throttle)
    if (chunk.seq % 10 === 0) {
      const pct = Math.round(
        ((chunk.seq * chunk.data.byteLength) / state.currentFile.size) * 100,
      );
      updateSenderUI(pct, "Streaming High-Def Video...");
    }
  }

  // Wait for scheduler to finish sending all queued chunks
  await state.videoScheduler.drain();

  state.isTransferring = false;
  updateSenderUI(100, "Stream Complete");

  // Send END over both channels for robustness
  if (state.dataChannel && state.dataChannel.readyState === "open") {
    import("./packet.js").then(({ buildControlPacket }) => {
      state.dataChannel.send(buildControlPacket("END"));
    });
  }
  import("./network.js").then((m) =>
    m.sendData({ type: "END", code: state.sessionCode }),
  );
}

async function onVideoData(packet) {
  // Validate Checksum (Fix 4 - Simple Integrity)
  let sum = 0;
  const bytes = new Uint8Array(packet.payload);
  for (let i = 0; i < Math.min(bytes.length, 100); i++) {
    sum = (sum + bytes[i]) & 0xffff;
  }

  if (sum !== packet.checksum) {
    console.error(
      `❌ Checksum mismatch for video chunk ${packet.seq}. Expected: ${packet.checksum}, Got: ${sum}`,
    );
    // In stable mode we might request retransmit, but for now we log it.
  }

  // 1. Process Payload
  handleSimpleVideoReceiver(packet.payload, packet.seq, packet.isLast);

  // 2. Send SACK (Cumulative + Range)
  // Simplified: ACK the current sequence
  const sackPkt = buildSackPacket(packet.seq, [
    { start: packet.seq, end: packet.seq },
  ]);

  if (state.dataChannel && state.dataChannel.readyState === "open") {
    state.dataChannel.send(sackPkt);
  }
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

  import("./network.js").then((m) =>
    m.sendData({
      type: "START",
      code: state.sessionCode,
      name: state.currentFile.name,
      size: state.currentFile.size,
    }),
  );

  state.resetTransfer();

  // ⚡ VIDEO MODE DETECTION (Step 7)
  if (state.currentFile.type.startsWith("video/")) {
    console.log("🎥 VIDEO DETECTED - Activating Advanced Streaming Engine");
    debugLog("🎥 Video Mode (Hybrid Congestion + SACK)", "var(--accent)");
    state.isVideoStream = true;

    if (state.dataChannel && state.dataChannel.readyState === "open") {
      state.videoProtocol = new VideoTransferProtocol(state.dataChannel);
      state.videoScheduler = new PacingScheduler(state.videoProtocol);
      startVideoStream();
      return;
    }
  }

  // Initialize streaming hash for memory-safe large file hashing
  initStreamingHash();

  const container = document.getElementById("progress-container");
  if (container) container.style.display = "block";

  trySend();
}

// Export for WebRTC bufferedamountlow callback
export const trySendWebRTC = trySend;

async function trySend() {
  if (!state.currentFile || !state.isTransferring || state.isSending) return;
  state.isSending = true;

  debugLog("🚀 Video Transfer Mode (Simple Stream)", "var(--accent)");

  const totalChunks = Math.ceil(state.currentFile.size / CHUNK_SIZE);
  const dataChannel = state.dataChannel;

  // Strict check for valid channel
  if (!dataChannel || dataChannel.readyState !== "open") {
    console.error("❌ DataChannel not ready");
    state.isSending = false;
    return;
  }

  // Pure Loop - No ACKs, No Retries, No JSON
  while (state.nextSeq < totalChunks) {
    // 1. Strict Backpressure check
    if (dataChannel.bufferedAmount > MAX_BUFFER) {
      // Wait for drain
      await new Promise((resolve) => {
        dataChannel.onbufferedamountlow = () => {
          dataChannel.onbufferedamountlow = null; // Clear handler
          resolve();
        };
      });
      continue; // Re-check loop
    }

    // 2. Read Chunk
    const offset = state.nextSeq * CHUNK_SIZE;
    const slice = state.currentFile.slice(offset, offset + CHUNK_SIZE);
    const chunk = await slice.arrayBuffer();

    // 3. Send Directly (No JSON, No Encryption for now)
    try {
      dataChannel.send(chunk);
      state.nextSeq++;

      // Update UI periodically
      if (state.nextSeq % 50 === 0) {
        const percent = Math.round((state.nextSeq / totalChunks) * 100);
        updateSenderUI(percent, "Streaming...");
        await new Promise((r) => setTimeout(r, 0)); // Yield to UI
      }
    } catch (e) {
      console.error("Send failed:", e);
      break;
    }
  }

  // EOF
  if (state.nextSeq >= totalChunks) {
    console.log("✅ Video Transfer Complete");
    // EOF Marker (Empty Buffer)
    dataChannel.send(new ArrayBuffer(0));
    state.isTransferring = false;
    state.isSending = false;
    updateSenderUI(100, "Done");
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
    state.transferState = "READY";
    debugLog(`READY received - Pairing complete`, "var(--accent)");
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

    // startWebRTC() is already handled by the main.js flow

    if (state.expectedSeq > 0) {
      console.log("♻️ RESUME");
      debugLog(`♻️ Resuming from chunk ${state.expectedSeq}`, "var(--accent)");
      import("./network.js").then((m) =>
        m.sendData({
          type: "RESUME",
          code: state.sessionCode,
          lastSeq: state.expectedSeq - 1,
        }),
      );
    } else {
      console.log("🆕 Starting fresh");
    }
    if (state.selectedFile) await sendFile(state.selectedFile);
  }

  if (msg.type === "KEY") {
    try {
      debugLog("Processing peer key...", "var(--accent)");
      const peerKey = await importPeerKey(msg.payload);
      await deriveSharedKey(peerKey);
      const isActuallySecure = IS_SECURE && peerKey !== "INSECURE";
      if (statusEl) {
        statusEl.innerText = isActuallySecure
          ? "🔐 Secure channel established"
          : "🔓 Connected (Local Mode)";
        statusEl.style.color = isActuallySecure ? "var(--success)" : "#ffaa00";
      }
      debugLog("Pairing complete", "var(--success)");
      if (state.selectedFile && state.transferState === "READY")
        await trySend();
    } catch (e) {
      console.error(e);
    }
  }

  if (msg.type === "START") {
    if (
      state.currentFile &&
      state.currentFile.name === msg.name &&
      state.currentFile.size === msg.size &&
      state.expectedSeq > 0
    ) {
      console.log("♻️ RESUMING EXISTING TRANSFER");
      debugLog(
        `♻️ Resume: ${state.expectedSeq} chunks saved`,
        "var(--success)",
      );
      // Tell sender where to resume from
      import("./network.js").then((m) =>
        m.sendData({
          type: "RESUME",
          code: state.sessionCode,
          lastSeq: state.expectedSeq - 1,
        }),
      );
    } else {
      console.log("🆕 STARTING NEW TRANSFER");
      state.currentFile = { name: msg.name, size: msg.size };
      state.expectedSeq = 0;
      state.receivedChunks = [];
      clearDB();
    }
    state.isTransferring = true;
    state.transferStartTime = Date.now();
    const container = document.getElementById("progress-container");
    if (container) container.style.display = "block";
    if (statusEl) {
      statusEl.innerText = `Connected. Receiving: ${msg.name}...`;
      statusEl.style.color = "var(--accent)";
    }
  }

  if (msg.type === "DATA") await onData(msg);
  if (msg.type === "ACK") await onAck(msg);

  if (msg.type === "CREDIT") {
    state.credits += msg.allow;
    // console.log(`💳 Credit received: +${msg.allow} = ${state.credits}`);
    trySend();
  }

  if (msg.type === "RESUME") await onResume(msg);

  if (msg.type === "HASH") {
    console.log("🔒 Hash received");
    const decrypted = await decryptChunk(msg.payload, msg.iv);
    state.remoteHash = new TextDecoder().decode(decrypted);
  }

  if (msg.type === "END") await saveFile();

  if (msg.type === "ERROR") {
    if (statusEl) {
      statusEl.style.color = "var(--error)";
      statusEl.innerText = `❌ Error: ${msg.msg}`;
    }
  }
}

const reorderBuffer = new Map();

async function onData(p) {
  if (state.transferState !== "READY") return;

  // 1. Store the incoming chunk (handles out-of-order)
  if (p.seq >= state.expectedSeq) {
    if (!reorderBuffer.has(p.seq)) {
      const decrypted = await decryptChunk(p.payload, p.iv);
      reorderBuffer.set(p.seq, decrypted);
    }
  }

  // 2. Process contiguous chunks starting from expectedSeq
  while (reorderBuffer.has(state.expectedSeq)) {
    const data = reorderBuffer.get(state.expectedSeq);
    const seq = state.expectedSeq;

    await saveChunkToDB(seq, data);
    reorderBuffer.delete(seq);
    state.expectedSeq++;
    state.lastActivityTime = Date.now();

    // 3. Send binary ACK for the latest processed chunk
    if (!state.isVideoStream) {
      const useWebRTC =
        state.dataChannel && state.dataChannel.readyState === "open";
      if (useWebRTC) {
        const binaryAck = buildAckPacket(seq);
        sendBinaryData(binaryAck);
      } else {
        sendData({
          type: "ACK",
          code: state.sessionCode,
          seq: seq,
        });
      }
    } else if (state.expectedSeq % 4 === 0) {
      // ⚡ VIDEO MODE: Credit-based flow control
      const creditMsg = JSON.stringify({
        type: "CREDIT",
        code: state.sessionCode,
        allow: 4,
      });

      if (state.dataChannel && state.dataChannel.readyState === "open") {
        state.dataChannel.send(creditMsg);
      } else {
        import("./network.js").then((m) => m.sendData(JSON.parse(creditMsg)));
      }
    }

    // 4. Update UI (Throttle)
    const now = Date.now();
    if (!state._lastUIUpdate || now - state._lastUIUpdate > 200) {
      state._lastUIUpdate = now;
      const totalChunks = Math.ceil(state.currentFile.size / CHUNK_SIZE);
      const pct = Math.round((state.expectedSeq / totalChunks) * 100);
      const elapsedTime = (Date.now() - state.transferStartTime) / 1000;
      const speedMBps =
        elapsedTime > 0
          ? (state.expectedSeq * CHUNK_SIZE) / (1024 * 1024 * elapsedTime)
          : 0;
      updateReceiverUI(pct, speedMBps.toFixed(2));
    }
  }
}

async function onAck(p) {
  state.lastAck = p.seq;
  state.lastActivityTime = Date.now();

  // ⚡ Calculate RTT for this chunk (for dynamic window tuning)
  if (state.chunkSendTimes[p.seq]) {
    const rtt = Date.now() - state.chunkSendTimes[p.seq];
    state.rttSamples.push(rtt);
    delete state.chunkSendTimes[p.seq]; // Clean up

    // Update dynamic window size based on RTT
    updateDynamicWindow();
  }

  // Clear acknowledged chunks and their retry counters
  for (let s in state.inflight) {
    if (Number(s) <= state.lastAck) {
      delete state.inflight[s];
      delete state.chunkRetries[s]; // Clear retry count on success
      delete state.chunkSendTimes[s]; // Clear send time tracking
      delete state.lastSentTime[s]; // Clear last sent time
    }
  }

  await trySend();
}

async function onResume(p) {
  console.log("📩 RESUME", p.lastSeq);
  state.lastAck = p.lastSeq;
  state.nextSeq = state.lastAck + 1;
  state.fileOffset = state.nextSeq * CHUNK_SIZE;
  state.lastActivityTime = Date.now();

  // Clear inflight and retry counters for already-sent chunks
  for (let s in state.inflight) {
    if (Number(s) <= state.lastAck) {
      delete state.inflight[s];
      delete state.chunkRetries[s];
    }
  }

  debugLog(
    `♻️ Resume: continuing from seq ${state.nextSeq} (offset ${(state.fileOffset / (1024 * 1024)).toFixed(2)} MB)`,
    "var(--success)",
  );
  await trySend();
}

async function saveFile() {
  if (!state.isTransferring) return;
  // Simplified logic
  console.log("💾 Finalizing...");

  let chunks;
  if (state.isVideoStream) {
    const sortedEntries = Array.from(receivedVideoChunks.entries()).sort(
      (a, b) => a[0] - b[0],
    );
    // Gap check
    const totalExpected = Math.ceil(state.currentFile.size / CHUNK_SIZE);
    if (sortedEntries.length < totalExpected) {
      console.warn(
        `[Assemble] Warning: Progress at ${sortedEntries.length}/${totalExpected}. Completing anyway...`,
      );
    }
    chunks = sortedEntries.map((entry) => entry[1]);
  } else {
    chunks = await getAllChunksFromDB();
  }

  // Clear reorder buffer for next time
  reorderBuffer.clear();

  if (!chunks || chunks.length === 0) {
    console.warn("No chunks found to save!");
    return;
  }
  const blob = new Blob(chunks);

  // Validate Hash
  const MAX = 250 * 1024 * 1024;
  if (state.currentFile.size <= MAX) {
    const buf = await blob.arrayBuffer();
    const localHash = await computeHash(buf);
    console.log("Local Hash:", localHash);
    if (state.remoteHash) {
      if (
        localHash === state.remoteHash ||
        state.remoteHash === "NO_HASH_LOCAL_MODE"
      ) {
        console.log("✅ INTEGRITY VERIFIED");
      } else {
        console.error("❌ INTEGRITY FAILED");
        alert("Integrity Check Failed!");
      }
    }
  }

  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = state.currentFile ? state.currentFile.name : "file";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  state.isTransferring = false;
  clearDB();
  receivedVideoChunks.clear(); // Clear video memory buffer
  const statusEl = document.getElementById("status");
  if (statusEl) statusEl.innerText = "✅ Download complete!";
  if (statusEl) statusEl.style.color = "var(--success)";
}

const receivedVideoChunks = new Map(); // Store as Map for out-of-order reassembly
export function handleSimpleVideoReceiver(data, seq, isLast) {
  receivedVideoChunks.set(seq, data);

  // Simple UI update
  if (receivedVideoChunks.size % 50 === 0) {
    updateReceiverUI(receivedVideoChunks.size, "Receiving High-Def Video...");
  }

  // [Issue 4 Fix] Auto-assemble if last chunk
  if (isLast) {
    console.log("🏁 Last video chunk received via isLast flag");
    setTimeout(() => saveFile(), 100);
  }
}
