let ws;
let isConnected = false;
let db = null;

// --- Crypto State (Disabled for Step 11) ---
let keyPair = null;
let sharedKey = null;

async function generateKeyPair() {
  keyPair = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveKey"],
  );
  console.log("ECDH Key Pair generated");
}

async function exportPublicKey() {
  const pub = await crypto.subtle.exportKey("raw", keyPair.publicKey);
  return bufToB64(pub);
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
  console.log("Shared AES-GCM key derived");
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

// --- Persistence (Disabled for Step 11 to follow "receivedChunks" instructions) ---
function initDB(cb) {
  if (cb) cb();
}
function clearDB() {}

// --- Connection ---
function connect(onConnected) {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const host = window.location.host;
  const wsUrl = `${protocol}//${host}/ws`;

  console.log("Connecting to:", wsUrl);
  const statusEl = document.getElementById("status");
  if (statusEl) statusEl.innerText = "Connecting to server...";

  ws = new WebSocket(wsUrl);

  ws.onopen = () => {
    console.log("Connected");
    isConnected = true;
    if (statusEl) statusEl.innerText = "Connected to Server. Ready.";
    generateKeyPair().then(() => {
      if (onConnected) onConnected();
    });
  };

  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);

    if (msg.type === "CODE") {
      state = "WAITING";
      sessionCode = msg.code;
      console.log("Code:", sessionCode);
      if (document.getElementById("invite-code")) {
        document.getElementById("invite-code").innerText = msg.code;
      }
      if (statusEl) statusEl.innerText = "Waiting for receiver...";
    }

    if (msg.type === "READY") {
      state = "READY";
      console.log("✅ READY — paired");
      if (statusEl) statusEl.innerText = "Pairing successful!";
      if (selectedFile) sendFile(selectedFile);
    }

    handleMessage(msg);
  };

  ws.onclose = () => {
    isConnected = false;
    state = "IDLE";
    console.log("Disconnected");
    if (statusEl) statusEl.innerText = "Disconnected. Retrying in 3s...";
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

async function handleMessage(msg) {
  const statusEl = document.getElementById("status");

  if (msg.type === "START") {
    currentFile = { name: msg.name, size: msg.size };
    expectedSeq = 0;
    receivedChunks = [];
    isTransferring = true;
    transferStartTime = Date.now();
    const container = document.getElementById("progress-container");
    if (container) container.style.display = "block";
    if (statusEl) statusEl.innerText = `Receiving: ${msg.name}...`;
    console.log("Transfer Started:", msg.name);
  }

  if (msg.type === "DATA") {
    onData(msg);
  }

  if (msg.type === "ACK") {
    onAck(msg);
  }

  if (msg.type === "END") {
    saveFile();
  }

  if (msg.type === "ERROR") {
    console.error("Server Error");
  }
}

// 11.2 — Receiver: Send ACKs
function onData(p) {
  if (state !== "READY") {
    console.error("❌ Not READY. Blocking DATA process.");
    return;
  }

  if (p.seq === expectedSeq) {
    console.log("Data received, seq:", p.seq);
    receivedChunks[p.seq] = base64ToArrayBuffer(p.payload);
    expectedSeq++;

    // ✅ SEND ACK
    ws.send(
      JSON.stringify({
        type: "ACK",
        code: sessionCode,
        seq: expectedSeq - 1,
      }),
    );

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

// 11.3 & 11.5 — Sender: Track and Clean ACKs
function onAck(p) {
  lastAck = p.seq;
  console.log("ACK received:", lastAck);

  for (let s in inflight) {
    if (Number(s) <= lastAck) {
      delete inflight[s];
    }
  }

  trySend();
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

function sendFile(file) {
  currentFile = file;
  if (state === "READY") {
    startTransfer();
  } else {
    document.getElementById("status").innerText =
      "File ready. Waiting for pairing...";
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

    console.log("Sending DATA, seq:", nextSeq);
    ws.send(
      JSON.stringify({
        type: "DATA",
        code: sessionCode,
        seq: nextSeq,
        payload: arrayBufferToBase64(arrayBuffer),
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
    ws.send(JSON.stringify({ type: "END", code: sessionCode }));
    document.getElementById("status").innerText = "File sent successfully!";
  }
}

// 11.6 — Retransmission Timer
setInterval(() => {
  if (state !== "READY" || !isTransferring) return;

  for (let seq in inflight) {
    console.log("Retransmitting chunk:", seq);
    ws.send(
      JSON.stringify({
        type: "DATA",
        code: sessionCode,
        seq: Number(seq),
        payload: arrayBufferToBase64(inflight[seq]),
      }),
    );
  }
}, 3000);

function saveFile() {
  console.log("Saving file...");
  const blob = new Blob(receivedChunks);
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = currentFile ? currentFile.name : "received_file";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);

  isTransferring = false;
  document.getElementById("status").innerText = "File received!";
  const bar = document.getElementById("progress-bar");
  if (bar) bar.style.width = "100%";
}

function updateReceiverUI(expectedSeq) {
  const totalBytes = expectedSeq * CHUNK_SIZE;
  const percent = Math.min(
    100,
    Math.round((totalBytes / currentFile.size) * 100),
  );
  const bar = document.getElementById("progress-bar");
  if (bar) bar.style.width = `${percent}%`;
  const statusEl = document.getElementById("status");
  if (statusEl) statusEl.innerText = `Receiving... ${percent}%`;
}

function updateSenderUI(offset) {
  const percent = Math.min(100, Math.round((offset / currentFile.size) * 100));
  const bar = document.getElementById("progress-bar");
  if (bar) bar.style.width = `${percent}%`;
  const statusEl = document.getElementById("status");
  if (statusEl) statusEl.innerText = `Sending... ${percent}%`;
}
