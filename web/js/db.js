import { state } from "./state.js";

export async function initDB(cb) {
  console.log("🔧 Initializing IndexedDB Persistence...");
  const request = indexedDB.open("SonicShareDB", 1);

  request.onupgradeneeded = (e) => {
    const db = e.target.result;
    if (!db.objectStoreNames.contains("chunks")) {
      db.createObjectStore("chunks");
      console.log("📦 Created IndexedDB store: 'chunks'");
    }
  };

  request.onsuccess = (e) => {
    state.db = e.target.result;
    console.log("✅ IndexedDB Ready");

    // Recover metadata from localStorage
    const savedSeq = localStorage.getItem("expectedSeq");
    if (savedSeq) {
      state.expectedSeq = parseInt(savedSeq);
      console.log("📋 Recovered progress: seq", state.expectedSeq);
    }
    const savedFile = localStorage.getItem("currentFile");
    if (savedFile) {
      state.currentFile = JSON.parse(savedFile);
      console.log("📋 Recovered file metadata:", state.currentFile.name);
    }

    if (cb) cb();
  };

  request.onerror = (e) => {
    console.error("❌ IndexedDB Failed:", e);
    if (cb) cb();
  };
}

export async function saveChunkToDB(seq, data) {
  if (!state.db) return;
  return new Promise((resolve, reject) => {
    const transaction = state.db.transaction(["chunks"], "readwrite");
    const store = transaction.objectStore("chunks");
    store.put(data, seq);

    transaction.oncomplete = () => {
      localStorage.setItem("expectedSeq", state.expectedSeq);
      localStorage.setItem("currentFile", JSON.stringify(state.currentFile));
      resolve();
    };
    transaction.onerror = () => reject(transaction.error);
  });
}

export async function getAllChunksFromDB() {
  return new Promise((resolve, reject) => {
    if (!state.db) return resolve([]);
    const transaction = state.db.transaction(["chunks"], "readonly");
    const store = transaction.objectStore("chunks");
    const request = store.getAll();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export function clearDB() {
  console.log("🧹 Clearing persistence state...");
  localStorage.removeItem("expectedSeq");
  localStorage.removeItem("currentFile");
  if (!state.db) return;
  const transaction = state.db.transaction(["chunks"], "readwrite");
  const store = transaction.objectStore("chunks");
  store.clear();
}
