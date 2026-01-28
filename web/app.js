let ws;
let isConnected = false;
let db = null;

// --- Crypto State (Step 13: E2EE) ---
let keyPair = null;
let sharedKey = null;

async function generateKeys() {
  console.log("🔐 Generating ECDH (P-256) keys...");
  keyPair = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveKey"],
  );
}

async function sendPublicKey() {
  const raw = await crypto.subtle.exportKey("raw", keyPair.publicKey);
  console.log("📡 Sending Public Key...");
  ws.send(
    JSON.stringify({
      type: "KEY",
      code: sessionCode,
      payload: bufToB64(raw),
    }),
  );
}

async function importPeerKey(b64) {
  const buf = b64ToBuf(b64);
  return await crypto.subtle.importKey(
    "raw",
    buf,
    { name: "ECDH", namedCurve: "P-256" },
    true,
    [],
  );
}

async function deriveSharedKey(peerPublicKey) {
  sharedKey = await crypto.subtle.deriveKey(
    { name: "ECDH", public: peerPublicKey },
    keyPair.privateKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
  console.log("🔐 Shared AES-GCM key derived & ready");
}

// 14.1 — Integrity Helper
async function computeHash(buffer) {
  const hashBuffer = await crypto.subtle.digest("SHA-256", buffer);
  return bufToB64(hashBuffer);
}

// 13.6 — Encrypt DATA Payload (Sender)
async function encryptChunk(buffer) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    sharedKey,
    buffer,
  );

  return {
    iv: bufToB64(iv),
    data: bufToB64(encrypted),
  };
}

// 13.7 — Decrypt DATA Payload (Receiver)
async function decryptChunk(b64Data, b64Iv) {
  try {
    return await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: b64ToBuf(b64Iv),
      },
      sharedKey,
      b64ToBuf(b64Data),
    );
  } catch (e) {
    console.error("❌ Decryption failed! Key mismatch?", e);
    throw e;
  }
}

// Byte Helpers
function bufToB64(buf) {
  let binary = "";
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i++)
    binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function b64ToBuf(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function arrayBufferToBase64(buffer) {
  return bufToB64(buffer);
}

function base64ToArrayBuffer(base64) {
  return b64ToBuf(base64).buffer;
}

// --- Persistence (Step 12: Resume Transfer) ---
async function initDB(cb) {
  console.log("🔧 Initializing IndexedDB Persistence...");
  const request = indexedDB.open("SonicShareDB", 1);

  request.onupgradeneeded = (e) => {
    db = e.target.result;
    if (!db.objectStoreNames.contains("chunks")) {
      db.createObjectStore("chunks");
      console.log("📦 Created IndexedDB store: 'chunks'");
    }
  };

  request.onsuccess = (e) => {
    db = e.target.result;
    console.log("✅ IndexedDB Ready");

    // Recover metadata from localStorage
    const savedSeq = localStorage.getItem("expectedSeq");
    if (savedSeq) {
      expectedSeq = parseInt(savedSeq);
      console.log("📋 Recovered progress: seq", expectedSeq);
    }
    const savedFile = localStorage.getItem("currentFile");
    if (savedFile) {
      currentFile = JSON.parse(savedFile);
      console.log("📋 Recovered file metadata:", currentFile.name);
    }

    if (cb) cb();
  };

  request.onerror = (e) => {
    console.error("❌ IndexedDB Failed:", e);
    if (cb) cb();
  };
}

// 15.1 — Sequential Message Processing
let messageQueue = Promise.resolve();

async function saveChunkToDB(seq, data) {
  if (!db) return;
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(["chunks"], "readwrite");
    const store = transaction.objectStore("chunks");
    const request = store.put(data, seq);

    // Persist metadata synchronously after transaction success
    transaction.oncomplete = () => {
      localStorage.setItem("expectedSeq", expectedSeq);
      localStorage.setItem("currentFile", JSON.stringify(currentFile));
      resolve();
    };
    transaction.onerror = () => reject(transaction.error);
  });
}

async function getAllChunksFromDB() {
  return new Promise((resolve, reject) => {
    if (!db) return resolve([]);
    const transaction = db.transaction(["chunks"], "readonly");
    const store = transaction.objectStore("chunks");
    const request = store.getAll();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function clearDB() {
  console.log("🧹 Clearing persistence state...");
  localStorage.removeItem("expectedSeq");
  localStorage.removeItem("currentFile");
  if (!db) return;
  const transaction = db.transaction(["chunks"], "readwrite");
  const store = transaction.objectStore("chunks");
  store.clear();
}

// --- Connection ---
function connect(onConnected) {
  // 12.6 — Ensure persistence is ready before connection
  if (!db) {
    initDB(() => connect(onConnected));
    return;
  }

  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const host = window.location.host;
  const wsUrl = `${protocol}//${host}/ws`;

  console.log("Connecting to:", wsUrl);
  const statusEl = document.getElementById("status");
  if (statusEl) statusEl.innerText = "Connecting to relay...";

  ws = new WebSocket(wsUrl);

  ws.onopen = () => {
    console.log("Connected");
    isConnected = true;
    if (statusEl) statusEl.innerText = "Connected! Ready to start.";
    if (onConnected) onConnected();
  };

  ws.onmessage = (event) => {
    // 15.2 — Wrap everything in a queue to prevent race conditions
    messageQueue = messageQueue
      .then(async () => {
        const msg = JSON.parse(event.data);
        const statusEl = document.getElementById("status");

        if (msg.type === "CODE") {
          state = "WAITING";
          sessionCode = msg.code;
          console.log("Code:", sessionCode);
          if (document.getElementById("invite-code")) {
            document.getElementById("invite-code").innerText = msg.code;
          }
          if (statusEl) {
            statusEl.innerText = "Waiting for receiver...";
            statusEl.style.color = "var(--text-secondary)";
          }
        }

        if (msg.type === "READY") {
          state = "READY";
          console.log("✅ READY — paired");
          if (statusEl) {
            statusEl.innerText = "Paired! Establishing secure channel...";
            statusEl.style.color = "var(--accent)";
          }

          await generateKeys();
          await sendPublicKey();

          if (expectedSeq > 0) {
            console.log(
              "📡 Progress detected. Sending RESUME:",
              expectedSeq - 1,
            );
            ws.send(
              JSON.stringify({
                type: "RESUME",
                code: sessionCode,
                lastSeq: expectedSeq - 1,
              }),
            );
          }

          if (selectedFile) await sendFile(selectedFile);
        }

        if (msg.type === "ERROR") {
          if (statusEl) {
            statusEl.style.color = "var(--error)";
            if (msg.msg === "INVALID_CODE") {
              statusEl.innerText = "❌ Error: Invalid invite code";
            } else if (msg.msg === "SESSION_FULL") {
              statusEl.innerText = "❌ Error: Session is full";
            } else if (msg.msg === "SESSION_EXPIRED") {
              statusEl.innerText = "❌ Error: Session has expired";
            } else {
              statusEl.innerText = "❌ Error: " + msg.msg;
            }
          }
        }

        await handleMessage(msg);
      })
      .catch((err) => {
        console.error("Critical Queue Error:", err);
      });
  };

  ws.onclose = () => {
    isConnected = false;
    state = "IDLE";
    console.log("Disconnected");
    if (statusEl) {
      statusEl.innerText = "⚠️ Connection lost. Retrying...";
      statusEl.style.color = "var(--error)";
    }
    setTimeout(() => connect(onConnected), 3000);
  };

  ws.onerror = (e) => {
    console.error("WS Error", e);
    if (statusEl) statusEl.innerText = "Connection Error. Check Server.";
  };
}

// --- State Machine & Reliability (Step 11) ---
let state = "IDLE";
let sessionCode = null;
let selectedFile = null;

const CHUNK_SIZE = 32 * 1024; // 32 KB
const WINDOW_SIZE = 8; // Sliding Window
let nextSeq = 0;
let lastAck = -1;
let inflight = {};
let expectedSeq = 0;
let receivedChunks = [];
let currentFile = null;
let isTransferring = false;
let isSending = false;
let transferStartTime = 0;
let remoteHash = null; // Store for verification

async function handleMessage(msg) {
  const statusEl = document.getElementById("status");

  if (msg.type === "START") {
    // 12.5 — Check if we should resume or reset
    if (
      currentFile &&
      currentFile.name === msg.name &&
      currentFile.size === msg.size &&
      expectedSeq > 0
    ) {
      console.log("♻️ Resuming transfer for:", msg.name);
      // Keep existing expectedSeq and chunks
    } else {
      console.log("🆕 Starting new transfer for:", msg.name);
      currentFile = { name: msg.name, size: msg.size };
      expectedSeq = 0;
      receivedChunks = [];
      clearDB();
    }

    isTransferring = true;
    transferStartTime = Date.now();
    const container = document.getElementById("progress-container");
    if (container) container.style.display = "block";
    if (statusEl) {
      statusEl.innerText = `Connected. Receiving: ${msg.name}...`;
      statusEl.style.color = "var(--accent)";
    }
  }

  if (msg.type === "DATA") {
    await onData(msg);
  }

  if (msg.type === "ACK") {
    await onAck(msg);
  }

  if (msg.type === "RESUME") {
    await onResume(msg);
  }

  if (msg.type === "KEY") {
    console.log("🔑 Peer key received. Deriving shared secret...");
    const peerKey = await importPeerKey(msg.payload);
    await deriveSharedKey(peerKey);

    if (statusEl) {
      statusEl.innerText = "🔐 Secure channel established";
      statusEl.style.color = "var(--success)";
    }

    // If we are the sender and have a file waiting, try sending now that key is ready
    if (selectedFile && state === "READY") await trySend();
  }

  if (msg.type === "HASH") {
    console.log("🔒 Integrity Hash received. Decrypting...");
    const decrypted = await decryptChunk(msg.payload, msg.iv);
    remoteHash = new TextDecoder().decode(decrypted);
    console.log("📋 Remote Hash (Decrypted):", remoteHash);
  }

  if (msg.type === "END") {
    await saveFile();
  }

  if (msg.type === "ERROR") {
    console.error("Server Error");
  }
}
// 11.2 — Receiver: Send ACKs
async function onData(p) {
  if (state !== "READY") {
    console.error("❌ Not READY. Blocking DATA process.");
    return;
  }

  if (p.seq === expectedSeq) {
    if (!sharedKey) {
      console.warn("⏳ DATA received but sharedKey not ready. Waiting...");
      return;
    }

    const decrypted = await decryptChunk(p.payload, p.iv);
    receivedChunks[p.seq] = decrypted;
    expectedSeq++;

    // ✅ SEND ACK
    ws.send(
      JSON.stringify({
        type: "ACK",
        code: sessionCode,
        seq: expectedSeq - 1,
      }),
    );

    // Save to Persistence (Ensure it's done index by index)
    await saveChunkToDB(p.seq, decrypted);
    updateReceiverUI(expectedSeq);
  } else {
    console.warn(
      "Out of order packet ignored. Expected:",
      expectedSeq,
      "Got:",
      p.seq,
    );
  }
}
async function onAck(p) {
  lastAck = p.seq;
  console.log("ACK received:", lastAck);

  for (let s in inflight) {
    if (Number(s) <= lastAck) {
      delete inflight[s];
    }
  }

  await trySend();
}

// 12.3 — Sender: Handle RESUME
async function onResume(p) {
  console.log("📩 RESUME received. Peer has up to seq:", p.lastSeq);
  lastAck = p.lastSeq;
  nextSeq = lastAck + 1;

  // clear inflight older packets
  for (let s in inflight) {
    if (Number(s) <= lastAck) {
      delete inflight[s];
    }
  }

  console.log("🚀 Resuming transfer from seq:", nextSeq);
  await trySend();
}

// --- Actions ---
function createSession() {
  if (!isConnected) return;
  ws.send(JSON.stringify({ action: "CREATE" }));
}

function joinSession(code) {
  if (!isConnected) return;
  sessionCode = code;
  ws.send(JSON.stringify({ action: "JOIN", code: code }));
}

async function sendFile(file) {
  currentFile = file;
  if (state === "READY") {
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
  if (!currentFile || state !== "READY") return;

  const totalChunks = Math.ceil(currentFile.size / CHUNK_SIZE);
  console.log("Starting Transfer. Total chunks:", totalChunks);

  ws.send(
    JSON.stringify({
      type: "START",
      code: sessionCode,
      name: currentFile.name,
      size: currentFile.size,
    }),
  );

  nextSeq = 0;
  lastAck = -1;
  inflight = {};
  isTransferring = true;
  transferStartTime = Date.now();
  const container = document.getElementById("progress-container");
  if (container) container.style.display = "block";

  trySend();
}

// 11.4 — Sliding Window (Sender)
async function trySend() {
  if (!currentFile || !isTransferring || isSending || state !== "READY") return;
  isSending = true;

  const totalChunks = Math.ceil(currentFile.size / CHUNK_SIZE);

  while (nextSeq <= lastAck + WINDOW_SIZE && nextSeq < totalChunks) {
    const offset = nextSeq * CHUNK_SIZE;
    const slice = currentFile.slice(offset, offset + CHUNK_SIZE);
    const arrayBuffer = await slice.arrayBuffer();

    console.log("Sending DATA, seq:", nextSeq, " (Encrypting...)");

    // 13.6 — Encrypt
    if (!sharedKey) {
      console.error("❌ Cannot send. sharedKey not established.");
      isSending = false;
      return;
    }

    const { data, iv } = await encryptChunk(arrayBuffer);

    ws.send(
      JSON.stringify({
        type: "DATA",
        code: sessionCode,
        seq: nextSeq,
        iv: iv,
        payload: data,
      }),
    );

    inflight[nextSeq] = arrayBuffer;
    nextSeq++;
  }

  isSending = false;

  const totalSent = Math.min(nextSeq * CHUNK_SIZE, currentFile.size);
  updateSenderUI(totalSent);

  // Check completion
  if (lastAck >= totalChunks - 1 && isTransferring) {
    isTransferring = false;

    // 14.1 — Compute and send HASH
    const fullBuffer = await currentFile.arrayBuffer();
    const fileHash = await computeHash(fullBuffer);
    console.log("✅ File sent. Integrity Hash:", fileHash);

    const encryptedHash = await encryptChunk(
      new TextEncoder().encode(fileHash),
    );

    ws.send(
      JSON.stringify({
        type: "HASH",
        code: sessionCode,
        iv: encryptedHash.iv,
        payload: encryptedHash.data,
      }),
    );

    ws.send(JSON.stringify({ type: "END", code: sessionCode }));
    if (statusEl) {
      statusEl.innerText = "✅ File sent successfully!";
      statusEl.style.color = "var(--success)";
    }
  }
}

// 11.6 — Retransmission Timer
setInterval(() => {
  if (state !== "READY" || !isTransferring) return;

  for (let seq in inflight) {
    console.log("Retransmitting chunk:", seq, " (Encrypted)");

    encryptChunk(inflight[seq]).then((encrypted) => {
      ws.send(
        JSON.stringify({
          type: "DATA",
          code: sessionCode,
          seq: Number(seq),
          iv: encrypted.iv,
          payload: encrypted.data,
        }),
      );
    });
  }
}, 3000);

async function saveFile() {
  console.log("💾 Finalizing file reconstruction...");
  const statusEl = document.getElementById("status");

  // Always load from DB to ensure no missing chunks (especially after resume)
  console.log("📂 Loading all chunks from IndexedDB store...");
  const dbChunks = await getAllChunksFromDB();

  if (dbChunks && dbChunks.length > 0) {
    receivedChunks = dbChunks;
  }

  if (receivedChunks.length === 0) {
    console.error("❌ No chunks found to reconstruct file!");
    if (statusEl) statusEl.innerText = "❌ Error: No data received.";
    return;
  }

  const blob = new Blob(receivedChunks);

  // 14.2 — Integrity Verification (with Memory Safety)
  const MAX_HASH_SIZE = 250 * 1024 * 1024; // 250MB safety cap
  if (currentFile && currentFile.size <= MAX_HASH_SIZE) {
    try {
      if (statusEl) {
        statusEl.innerText = "🔒 Verifying integrity...";
        statusEl.style.color = "var(--accent)";
      }
      console.log("🔒 Verifying integrity hash...");
      const fullBuffer = await blob.arrayBuffer();
      const localHash = await computeHash(fullBuffer);
      console.log("📋 Local Hash:", localHash);

      if (remoteHash) {
        if (localHash === remoteHash) {
          console.log("✅ INTEGRITY VERIFIED");
          if (statusEl) {
            statusEl.innerText = "✅ Verified! Download ready.";
            statusEl.style.color = "var(--success)";
          }
        } else {
          console.error("❌ INTEGRITY FAILED");
          if (statusEl) {
            statusEl.innerText = "❌ Error: Integrity check failed!";
            statusEl.style.color = "var(--error)";
          }
          alert(
            "Warning: File integrity check failed. The file may be corrupt.",
          );
        }
      }
    } catch (e) {
      console.error("Hash verification failed:", e);
    }
  } else {
    console.log(
      "⏩ File too large for browser memory hashing. Skipping integrity check.",
    );
  }

  // Trigger Download
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = currentFile ? currentFile.name : "received_file";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);

  isTransferring = false;
  if (statusEl) {
    statusEl.innerText = "✅ Download complete!";
    statusEl.style.color = "var(--success)";
  }
  const bar = document.getElementById("progress-bar");
  if (bar) bar.style.width = "100%";

  clearDB();
}

function updateReceiverUI(expectedSeq) {
  const totalBytes = Math.min(expectedSeq * CHUNK_SIZE, currentFile.size);
  const percent = Math.min(
    100,
    Math.round((totalBytes / currentFile.size) * 100),
  );
  const bar = document.getElementById("progress-bar");
  if (bar) bar.style.width = `${percent}%`;

  // Speed calculation
  const elapsed = (Date.now() - transferStartTime) / 1000;
  let speed = "0.00";
  if (elapsed > 0) {
    speed = (totalBytes / (1024 * 1024) / elapsed).toFixed(2);
  }

  const statusEl = document.getElementById("status");
  if (statusEl) statusEl.innerText = `Receiving... ${percent}% (${speed} MB/s)`;
}

function updateSenderUI(offset) {
  const actualOffset = Math.min(offset, currentFile.size);
  const percent = Math.min(
    100,
    Math.round((actualOffset / currentFile.size) * 100),
  );
  const bar = document.getElementById("progress-bar");
  if (bar) bar.style.width = `${percent}%`;

  // Speed calculation
  const elapsed = (Date.now() - transferStartTime) / 1000;
  let speed = "0.00";
  if (elapsed > 0) {
    speed = (actualOffset / (1024 * 1024) / elapsed).toFixed(2);
  }

  const statusEl = document.getElementById("status");
  if (statusEl) statusEl.innerText = `Sending... ${percent}% (${speed} MB/s)`;
}
