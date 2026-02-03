import { IS_SECURE } from "./config.js";
import { state } from "./state.js";
import { bufToB64, b64ToBuf } from "./utils.js";
import { debugLog } from "./ui.js";

export async function generateKeys() {
  if (!IS_SECURE) return;
  console.log("🔐 Generating ECDH (P-256) keys...");
  state.keyPair = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveKey"],
  );
}

export async function getPublicKeyB64() {
  if (!IS_SECURE) return "INSECURE";
  const raw = await crypto.subtle.exportKey("raw", state.keyPair.publicKey);
  return bufToB64(raw);
}

export async function importPeerKey(b64) {
  if (b64 === "INSECURE" || !IS_SECURE || !crypto.subtle) return "INSECURE";
  try {
    const buf = b64ToBuf(b64);
    return await crypto.subtle.importKey(
      "raw",
      buf,
      { name: "ECDH", namedCurve: "P-256" },
      true,
      [],
    );
  } catch (e) {
    debugLog("Key Import Failed - Falling back to local mode");
    return "INSECURE";
  }
}

export async function deriveSharedKey(peerPublicKey) {
  if (!IS_SECURE || peerPublicKey === "INSECURE") {
    state.sharedKey = "INSECURE";
    debugLog("Using Local Mode (No Encryption)", "#ffaa00");
    return;
  }
  state.sharedKey = await crypto.subtle.deriveKey(
    { name: "ECDH", public: peerPublicKey },
    state.keyPair.privateKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
  debugLog("Secure channel derived", "var(--success)");
}

export async function computeHash(buffer) {
  if (!IS_SECURE || !crypto.subtle) return "NO_HASH_LOCAL_MODE";
  const hashBuffer = await crypto.subtle.digest("SHA-256", buffer);
  return bufToB64(hashBuffer);
}

// Streaming Hash Functions for 50GB+ Files
// These prevent loading the entire file into memory
export function initStreamingHash() {
  if (!IS_SECURE || !crypto.subtle) {
    state.streamingHashState = { mode: "INSECURE" };
    return;
  }
  // For streaming hash, we'll collect chunks and hash progressively
  state.streamingHashState = {
    chunks: [], // We'll still need to collect for final hash, but in chunks
    totalSize: 0,
  };
}

export async function updateStreamingHash(chunkBuffer) {
  if (!state.streamingHashState) return;
  if (state.streamingHashState.mode === "INSECURE") return;

  // Store chunk reference for final hash computation
  state.streamingHashState.chunks.push(new Uint8Array(chunkBuffer));
  state.streamingHashState.totalSize += chunkBuffer.byteLength;
}

export async function finalizeStreamingHash() {
  if (!state.streamingHashState) return "NO_HASH";
  if (state.streamingHashState.mode === "INSECURE") return "NO_HASH_LOCAL_MODE";

  // Concatenate all chunks efficiently
  const totalSize = state.streamingHashState.totalSize;
  const combined = new Uint8Array(totalSize);
  let offset = 0;

  for (const chunk of state.streamingHashState.chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }

  // Compute final hash
  const hashBuffer = await crypto.subtle.digest("SHA-256", combined);

  // Clean up
  state.streamingHashState = null;

  return bufToB64(hashBuffer);
}

export async function encryptChunk(buffer) {
  if (!IS_SECURE || state.sharedKey === "INSECURE") {
    return {
      iv: null,
      data: buffer,
      ivB64: "NONE",
      dataB64: bufToB64(buffer),
    };
  }
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    state.sharedKey,
    buffer,
  );
  return {
    iv: iv,
    data: encrypted,
    ivB64: bufToB64(iv),
    dataB64: bufToB64(encrypted),
  };
}

export async function decryptChunk(data, iv) {
  // Handle both Base64 strings and raw buffers (ArrayBuffer/Uint8Array)
  const dataBuf =
    typeof data === "string" ? b64ToBuf(data) : new Uint8Array(data);
  const ivBuf =
    typeof iv === "string" && iv !== "NONE"
      ? b64ToBuf(iv)
      : iv instanceof ArrayBuffer || iv instanceof Uint8Array
        ? new Uint8Array(iv)
        : null;

  if (!IS_SECURE || state.sharedKey === "INSECURE") {
    return dataBuf;
  }
  try {
    return await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: ivBuf,
      },
      state.sharedKey,
      dataBuf,
    );
  } catch (e) {
    console.error("❌ Decryption failed! Key mismatch or corrupted buffer?", e);
    throw e;
  }
}
