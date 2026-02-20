import { SACK_BATCH_SIZE } from "./config.js";
export class SonicReceiver {
  constructor(sessionCode) {
    this.code = sessionCode;
    this.signaling = null;
    this.pc = null;
    this.dc = null;
    this.metadata = null;
    this.chunks = new Map();
    this.receivedBytes = 0;
    this.state = "idle"; // idle, connecting, receiving, assembling, completed, error
    this.db = null;
    this.transferId = null;
    this.cryptoKey = null;

    this.readySent = false;
    this.pendingAcks = [];
    this.ackTimer = null;
    // Config
    this.config = {
      chunkTimeout: 30000, // 30s without chunk = fail
      maxRetries: 3,
      dbName: "SonicShareDB",
      storeName: "chunks",
    };
  }

  async init() {
    console.log("[Receiver] Initializing...");
    this.state = "connecting";

    // Initialize IndexedDB
    await this.initDB();

    // Setup signaling
    const { SonicSignaling } = await import("./signaling-receiver.js");
    this.signaling = new SonicSignaling(this.code, "receiver");

    // Connect to session via REST API
    const session = await this.signaling.getSession();
    if (session.error) {
      throw new Error(session.error);
    }

    if (!session.offer) {
      throw new Error("Sender not ready yet");
    }

    console.log("[Receiver] Found session, creating answer...");

    // Create WebRTC connection
    await this.setupWebRTC(session.offer);

    // Connect WebSocket for ICE candidates
    await this.signaling.connectWebSocket();

    // Setup WebSocket handlers
    this.signaling.onIceCandidate = (candidate) => {
      if (candidate && this.pc) {
        this.pc.addIceCandidate(candidate).catch((e) => {
          console.error("[Receiver] Failed to add ICE candidate:", e);
        });
      }
    };

    // Send answer via REST API
    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);
    await this.signaling.postAnswer(answer);

    console.log("[Receiver] Answer sent, waiting for connection...");
    this.updateStatus("Connecting to sender...");

    return this;
  }

  async initDB() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.config.dbName, 1);

      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        this.db = request.result;
        resolve();
      };

      request.onupgradeneeded = (event) => {
        const db = event.target.result;
        if (!db.objectStoreNames.contains(this.config.storeName)) {
          const store = db.createObjectStore(this.config.storeName, {
            keyPath: "id",
          });
          store.createIndex("transferId", "transferId", { unique: false });
          store.createIndex("seq", "seq", { unique: false });
        }
        if (!db.objectStoreNames.contains("transfers")) {
          db.createObjectStore("transfers", { keyPath: "id" });
        }
      };
    });
  }

  async setupWebRTC(offer) {
    this.pc = new RTCPeerConnection({
      iceServers: [
        { urls: "stun:stun.l.google.com:19302" },
        { urls: "stun:stun1.l.google.com:19302" },
      ],
      iceCandidatePoolSize: 10,
    });

    // Share PC with global state
    if (window.sonicState) window.sonicState.pc = this.pc;

    // ICE handling
    this.pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.signaling.sendIceCandidate(event.candidate);
      }
    };

    this.pc.oniceconnectionstatechange = () => {
      console.log("[Receiver] ICE State:", this.pc.iceConnectionState);
      if (this.pc.iceConnectionState === "connected") {
        this.updateStatus("Direct P2P connected");
      } else if (this.pc.iceConnectionState === "failed") {
        this.handleError("ICE connection failed");
      }
    };

    this.pc.onconnectionstatechange = () => {
      console.log("[Receiver] Connection State:", this.pc.connectionState);
      if (this.pc.connectionState === "connected") {
        this.signaling.notifyTransferReady();
      }
    };

    // CRITICAL: Handle multiple data channels
    this.pc.ondatachannel = (event) => {
      const channel = event.channel;
      console.log("[Receiver] DataChannel received:", channel.label);

      if (channel.label === "control") {
        this.controlChannel = channel;
        this.setupControlChannel(channel);
      } else if (
        channel.label === "file" ||
        channel.label === "data" ||
        channel.label.startsWith("fast-")
      ) {
        // Reuse the logic for parallel channels
        if (!this.dc) this.dc = channel; // Main channel for outgoing
        this.configureDataChannel(channel);
      }
    };

    // Set remote description (offer from sender)
    await this.pc.setRemoteDescription(offer);
  }

  setupControlChannel(channel) {
    channel.onopen = () => {
      console.log("[Receiver] Control Channel OPEN");
      if (this.dc && this.dc.readyState === "open" && !this.readySent) {
        this.readySent = true;
        this.sendControl({ type: "READY" });
      }
    };
    channel.onmessage = (event) => this.handleMessage(event.data);
  }

  configureDataChannel(channel) {
    // CRITICAL FIX: Must set binaryType BEFORE any other operations
    channel.binaryType = "arraybuffer";

    channel.onopen = () => {
      console.log("[Receiver] DataChannel OPEN");
      this.state = "receiving";

      // Update UI button
      const btn = document.getElementById("join-btn");
      if (btn) {
        btn.innerText = "Connected";
        btn.style.background = "var(--success)";
        btn.style.opacity = "1";
      }

      // If control channel is already open, notify ready
      if (
        this.controlChannel &&
        this.controlChannel.readyState === "open" &&
        !this.readySent
      ) {
        this.readySent = true;
        this.sendControl({ type: "READY" });
      }
    };

    this.dc.onerror = (e) => {
      console.error("[Receiver] DataChannel error:", e);
      this.handleError("Data channel error");
    };

    this.dc.onclose = () => {
      console.log("[Receiver] DataChannel closed");
      if (this.state === "receiving") {
        // Unexpected close during transfer
        this.handleError("Connection closed unexpectedly");
      }
    };

    channel.onmessage = (event) => this.handleMessage(event.data);
  }

  sendControl(msg) {
    const json = JSON.stringify(msg);
    if (this.controlChannel && this.controlChannel.readyState === "open") {
      this.controlChannel.send(json);
    } else if (this.dc && this.dc.readyState === "open") {
      this.dc.send(json);
    }
  }

  handleMessage(data) {
    // Log raw data for debugging
    console.log(
      "[Receiver] Raw message:",
      "Type:",
      typeof data,
      "Constructor:",
      data?.constructor?.name,
      "Size:",
      data?.byteLength || data?.length || "N/A",
    );

    // String messages (metadata, control)
    if (typeof data === "string") {
      try {
        const msg = JSON.parse(data);
        this.handleControlMessage(msg);
      } catch (e) {
        console.error("[Receiver] Failed to parse string message:", e);
      }
      return;
    }

    // Binary data (file chunks)
    if (data instanceof ArrayBuffer) {
      this.handleBinaryChunk(data);
      return;
    }

    // Blob handling (if binaryType was 'blob')
    if (data instanceof Blob) {
      // Convert blob to arraybuffer
      const reader = new FileReader();
      reader.onload = () => this.handleBinaryChunk(reader.result);
      reader.readAsArrayBuffer(data);
      return;
    }

    console.error("[Receiver] Unknown data type:", data);
  }

  async handleControlMessage(msg) {
    console.log("[Receiver] Control:", msg.type);

    switch (msg.type) {
      case "KEY":
        await this.handleKeyExchange(msg.payload);
        break;
      case "READY":
        // This is a READY feedback from sender confirming they received our READY
        console.log("[Receiver] Sender is READY");
        break;
      case "METADATA":
        this.handleMetadata(msg);
        break;
      case "CHUNK_ACK":
        // Sender confirming they got our ACK (ignore or log)
        break;
      case "TRANSFER_COMPLETE":
        console.log("[Receiver] Sender reports complete");
        break;
      case "ERROR":
        this.handleError(msg.message);
        break;
      default:
        console.log("[Receiver] Unknown control type:", msg.type);
    }
  }

  async handleKeyExchange(peerKeyB64) {
    const { importPeerKey, deriveSharedKey, getPublicKeyB64 } =
      await import("./crypto.js");
    const { sendData } = await import("./network.js");

    this.updateStatus("Processing secure keys...", "var(--accent)");
    const peerKey = await importPeerKey(peerKeyB64);
    await deriveSharedKey(peerKey);

    // Send our key back if initiator didn't get it yet
    const myKey = await getPublicKeyB64();
    this.sendControl({
      type: "KEY",
      payload: myKey,
    });

    this.updateStatus("Secure channel established", "var(--success)");
  }

  handleMetadata(msg) {
    this.metadata = {
      fileName: msg.fileName,
      fileSize: msg.fileSize,
      mimeType: msg.mimeType,
      totalChunks: msg.totalChunks,
      chunkSize: msg.chunkSize,
      encrypted: msg.encrypted || false,
      timestamp: Date.now(),
    };

    this.transferId = `${this.code}_${this.metadata.fileName}_${this.metadata.fileSize}`;

    console.log("[Receiver] Metadata received:", this.metadata);

    // Check for existing resume data
    this.checkResume().then((resumeData) => {
      if (resumeData.hasResume && resumeData.receivedBytes > 0) {
        console.log(
          `[Receiver] Resuming from ${resumeData.receivedBytes} bytes`,
        );
        this.chunks = resumeData.chunks;
        this.receivedBytes = resumeData.receivedBytes;

        // Tell sender where to resume from
        this.sendControl({
          type: "RESUME_FROM",
          byteOffset: resumeData.receivedBytes,
          receivedChunks: Array.from(resumeData.chunks.keys()),
        });

        this.updateProgress();
      } else {
        // Fresh start
        this.chunks.clear();
        this.receivedBytes = 0;
        this.sendControl({ type: "START_TRANSFER" });
      }
    });

    this.updateStatus(`Receiving: ${this.metadata.fileName}`);
  }

  async handleBinaryChunk(arrayBuffer) {
    try {
      // Minimum header size check
      if (arrayBuffer.byteLength < 16) {
        console.error("[Receiver] Chunk too small:", arrayBuffer.byteLength);
        return;
      }

      // Parse 16-byte header
      const view = new DataView(arrayBuffer);
      const header = {
        seq: view.getUint32(0),
        size: view.getUint32(4),
        offset: view.getUint32(8),
        flags: view.getUint8(12),
        reserved: view.getUint8(13),
        checksum: view.getUint16(14),
      };

      const isLast = (header.flags & 0x01) !== 0;
      const isEncrypted = (header.flags & 0x02) !== 0;

      // Validate chunk size
      const expectedSize = 16 + header.size;
      if (arrayBuffer.byteLength !== expectedSize) {
        console.error(
          `[Receiver] Size mismatch: header=${header.size}, actual=${arrayBuffer.byteLength - 16}`,
        );
        this.requestRetransmit(header.seq);
        return;
      }

      // Extract payload
      const payload = new Uint8Array(arrayBuffer, 16, header.size);

      // Verify checksum (simple sum of first 100 bytes)
      const calculatedChecksum = this.calculateChecksum(payload);
      if (calculatedChecksum !== header.checksum) {
        console.error(`[Receiver] Checksum failed for seq ${header.seq}`);
        this.requestRetransmit(header.seq);
        return;
      }

      // Decrypt if needed
      let data = payload;
      if (isEncrypted && this.cryptoKey) {
        try {
          data = await this.decryptChunk(payload, header.seq);
        } catch (e) {
          console.error(`[Receiver] Decrypt failed for seq ${header.seq}:`, e);
          this.requestRetransmit(header.seq);
          return;
        }
      }

      console.log(
        `[Receiver] Chunk ${header.seq}: ${data.length} bytes, offset ${header.offset}, last=${isLast}`,
      );

      // Store chunk METADATA only (not the actual data pixels/bytes to save RAM)
      this.chunks.set(header.seq, {
        offset: header.offset,
        size: data.length,
        receivedAt: Date.now(),
        isLast: isLast,
      });

      this.receivedBytes += data.length;

      // Save to IndexedDB (CRITICAL: This is where the actual data lives)
      this.saveChunk(header.seq, data, header.offset, isLast);

      // Batch ACK only (Individual ACK disabled for speed)

      // Batch ACK
      this.pendingAcks.push(header.seq);
      if (this.pendingAcks.length >= SACK_BATCH_SIZE) {
        this.sendBatchAck();
      } else if (!this.ackTimer) {
        this.ackTimer = setTimeout(() => this.sendBatchAck(), 100);
      }

      // Check if complete
      if (isLast || this.receivedBytes >= this.metadata.fileSize) {
        console.log("[Receiver] Last chunk detected, assembling...");
        setTimeout(() => this.assembleFile(), 100);
      }
    } catch (e) {
      console.error("[Receiver] Chunk processing error:", e);
    }
  }

  sendBatchAck() {
    if (this.pendingAcks.length === 0) return;
    this.updateProgress();
    this.sendControl({
      type: "CHUNK_BATCH_ACK",
      sequences: this.pendingAcks,
      receivedBytes: this.receivedBytes,
    });
    this.pendingAcks = [];
    if (this.ackTimer) {
      clearTimeout(this.ackTimer);
      this.ackTimer = null;
    }
  }

  calculateChecksum(data) {
    let sum = 0;
    const len = Math.min(data.length, 100);
    for (let i = 0; i < len; i++) {
      sum = (sum + data[i]) & 0xffff;
    }
    return sum;
  }

  async decryptChunk(encryptedData, seq) {
    const { decryptChunk } = await import("./crypto.js");
    try {
      // Reconstruct deterministic 12-byte IV from sequence number
      const customIv = new Uint8Array(12);
      const ivView = new DataView(customIv.buffer);
      ivView.setUint32(8, seq, false);

      return await decryptChunk(encryptedData, customIv);
    } catch (e) {
      console.error("Decryption failed for seq", seq, e);
      throw e;
    }
  }

  async saveChunk(seq, data, offset, isLast) {
    if (!this.db) return;

    try {
      const transaction = this.db.transaction(
        [this.config.storeName],
        "readwrite",
      );
      const store = transaction.objectStore(this.config.storeName);

      await new Promise((resolve, reject) => {
        const request = store.put({
          id: `${this.transferId}_${seq}`,
          transferId: this.transferId,
          seq: seq,
          data: data,
          offset: offset,
          size: data.length,
          isLast: isLast,
          savedAt: Date.now(),
        });
        request.onsuccess = resolve;
        request.onerror = reject;
      });
    } catch (e) {
      console.warn("[Receiver] Failed to save chunk to DB:", e);
    }
  }

  async getAllChunksFromDB() {
    if (!this.db || !this.transferId) return [];

    return new Promise((resolve, reject) => {
      try {
        const transaction = this.db.transaction(
          [this.config.storeName],
          "readonly",
        );
        const store = transaction.objectStore(this.config.storeName);
        const index = store.index("transferId");
        const request = index.getAll(this.transferId);

        request.onsuccess = () => resolve(request.result || []);
        request.onerror = () => reject(request.error);
      } catch (e) {
        reject(e);
      }
    });
  }

  async checkResume() {
    if (!this.db)
      return { hasResume: false, chunks: new Map(), receivedBytes: 0 };

    try {
      const transaction = this.db.transaction(
        [this.config.storeName],
        "readonly",
      );
      const store = transaction.objectStore(this.config.storeName);
      const index = store.index("transferId");

      const chunks = await new Promise((resolve) => {
        const request = index.getAll(this.transferId);
        request.onsuccess = () => resolve(request.result || []);
      });

      if (chunks.length === 0) {
        return { hasResume: false, chunks: new Map(), receivedBytes: 0 };
      }

      const chunkMap = new Map();
      let totalBytes = 0;

      for (const chunk of chunks) {
        chunkMap.set(chunk.seq, {
          data: chunk.data,
          offset: chunk.offset,
          size: chunk.size,
          isLast: chunk.isLast,
        });
        totalBytes += chunk.size;
      }

      return {
        hasResume: true,
        chunks: chunkMap,
        receivedBytes: totalBytes,
        chunkCount: chunks.length,
      };
    } catch (e) {
      console.warn("[Receiver] Resume check failed:", e);
      return { hasResume: false, chunks: new Map(), receivedBytes: 0 };
    }
  }

  async assembleFile() {
    if (this.state === "assembling" || this.state === "completed") return;

    this.state = "assembling";
    console.log(`[Receiver] Assembling ${this.chunks.size} chunks...`);

    try {
      // Sort by sequence number
      const sorted = Array.from(this.chunks.entries()).sort(
        (a, b) => a[0] - b[0],
      );

      // Check for gaps
      const missing = [];
      let expectedSeq = 0;
      for (const [seq, chunk] of sorted) {
        while (expectedSeq < seq) {
          missing.push(expectedSeq);
          expectedSeq++;
        }
        expectedSeq++;
      }

      if (missing.length > 0) {
        console.warn(`[Receiver] Missing chunks: ${missing.join(", ")}`);
        this.requestRetransmit(missing);
        this.state = "receiving";
        return;
      }

      // Combine chunks efficiently from IndexedDB
      this.updateStatus("Reading from Local Cache...");
      const dbChunks = await this.getAllChunksFromDB();
      const finalSorted = dbChunks.sort((a, b) => a.seq - b.seq);

      // Verify and Combine
      const totalSize = finalSorted.reduce((sum, c) => sum + c.size, 0);
      const result = new Uint8Array(totalSize);
      let offset = 0;

      for (const chunk of finalSorted) {
        result.set(new Uint8Array(chunk.data), offset);
        offset += chunk.size;
      }

      console.log(`[Receiver] File assembled: ${totalSize} bytes`);

      // Create blob
      const blob = new Blob([result], { type: this.metadata.mimeType });

      // Trigger download
      await this.downloadFile(blob, this.metadata.fileName);

      // Cleanup
      this.state = "completed";
      this.cleanup();
      this.signaling.notifyTransferComplete();

      this.updateStatus("Download complete!");
      this.updateProgress(100);
    } catch (e) {
      console.error("[Receiver] Assembly failed:", e);
      this.handleError("Failed to assemble file");
    }
  }

  async downloadFile(blob, fileName) {
    // Method 1: Download link
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();

    setTimeout(() => {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 100);

    // Method 2: File System Access API (if available)
    if ("showSaveFilePicker" in window) {
      try {
        const handle = await window.showSaveFilePicker({
          suggestedName: fileName,
          types: [
            {
              description: "Downloaded file",
              accept: { [blob.type || "*/*"]: [".*"] },
            },
          ],
        });

        const writable = await handle.createWritable();
        await writable.write(blob);
        await writable.close();

        console.log("[Receiver] Saved via File System Access API");
      } catch (e) {
        // User cancelled or API failed, download link already triggered
      }
    }
  }

  requestRetransmit(sequences) {
    const seqs = Array.isArray(sequences) ? sequences : [sequences];
    console.log("[Receiver] Requesting retransmit:", seqs);

    this.sendControl({
      type: "RETRANSMIT_REQUEST",
      sequences: seqs,
    });
  }

  updateProgress(percent = null) {
    if (!this.metadata) return;

    const pct =
      percent !== null
        ? percent
        : Math.min(100, (this.receivedBytes / this.metadata.fileSize) * 100);

    const mb = (this.receivedBytes / 1024 / 1024).toFixed(2);
    const totalMb = (this.metadata.fileSize / 1024 / 1024).toFixed(2);

    console.log(`[Progress] ${pct.toFixed(1)}% (${mb}/${totalMb} MB)`);

    // Update UI
    const progressBar = document.getElementById("progress-bar");
    const progressText = document.getElementById("progress-text");

    if (progressBar) {
      progressBar.style.width = `${pct}%`;
    }
    if (progressText) {
      progressText.textContent = `${pct.toFixed(1)}% - ${mb} / ${totalMb} MB`;
    }
  }

  updateStatus(message, color = "var(--accent)") {
    console.log("[Status]", message);
    const statusEl = document.getElementById("status");
    if (statusEl) {
      statusEl.textContent = message;
      statusEl.style.color = color;
    }
    // Import debugLog dynamically to avoid circular dependencies if any
    import("./ui.js").then((m) => m.debugLog(message, color));
  }

  handleError(message) {
    console.error("[Receiver] Error:", message);
    this.state = "error";
    this.updateStatus(`Error: ${message}`, "var(--error)");

    // Notify sender
    this.sendControl({
      type: "ERROR",
      message: message,
    });
  }

  async cleanup() {
    // Clear IndexedDB after successful transfer
    if (this.db && this.transferId) {
      try {
        const transaction = this.db.transaction(
          [this.config.storeName],
          "readwrite",
        );
        const store = transaction.objectStore(this.config.storeName);
        const index = store.index("transferId");

        const chunks = await new Promise((resolve) => {
          const request = index.getAll(this.transferId);
          request.onsuccess = () => resolve(request.result);
        });

        for (const chunk of chunks) {
          store.delete(chunk.id);
        }

        console.log(
          "[Receiver] Cleanup complete, deleted",
          chunks.length,
          "chunks",
        );
      } catch (e) {
        console.warn("[Receiver] Cleanup failed:", e);
      }
    }

    // Close connections
    if (this.dc) {
      this.dc.close();
    }
    if (this.pc) {
      this.pc.close();
    }
    if (this.signaling) {
      this.signaling.disconnect();
    }
  }

  destroy() {
    this.cleanup();
  }
}
