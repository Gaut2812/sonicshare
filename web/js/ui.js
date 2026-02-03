import { state } from "./state.js";
import { IS_SECURE } from "./config.js";

export function debugLog(msg, color = "var(--text-secondary)") {
  console.log(`[DEBUG] ${msg}`);
  const statusEl = document.getElementById("status");
  if (statusEl) {
    const logLine = document.createElement("div");
    logLine.style = `font-size: 0.75rem; color: ${color}; margin-top: 4px; border-top: 1px solid rgba(255,255,255,0.05); padding-top: 4px;`;
    logLine.innerText = `> ${msg}`;

    let container = document.getElementById("debug-logs");
    if (!container) {
      container = document.createElement("div");
      container.id = "debug-logs";
      container.style =
        "margin-top: 1rem; max-height: 150px; overflow-y: auto; text-align: left; background: rgba(0,0,0,0.3); border-radius: 8px; padding: 8px; border: 1px solid var(--glass-border);";
      statusEl.parentNode.insertBefore(container, statusEl.nextSibling);
    }
    container.insertBefore(logLine, container.firstChild);
  }
}

export function injectLocalModeUI() {
  const statusEl = document.getElementById("status");
  if (statusEl) {
    statusEl.innerHTML = IS_SECURE
      ? "🔒 <b style='color:#10b981;'>Secure Mode:</b> End-to-end encrypted."
      : "🔓 <b style='color:#ffaa00;'>Local Mode:</b> Encryption disabled (No HTTPS).";
  }

  if (!document.getElementById("connection-mode-badge")) {
    const badge = document.createElement("div");
    badge.id = "connection-mode-badge";
    badge.style = `
      position: fixed; 
      bottom: 20px; 
      right: 20px; 
      background: ${IS_SECURE ? "#10b981" : "#ffaa00"}; 
      color: #000; 
      padding: 10px 20px; 
      border-radius: 50px; 
      font-weight: 800; 
      font-size: 14px; 
      z-index: 99999; 
      box-shadow: 0 10px 30px rgba(0,0,0,0.5);
      border: 2px solid rgba(255,255,255,0.2);
    `;
    badge.innerText = IS_SECURE ? "SECURE MODE" : "LOCAL MODE (UNENCRYPTED)";
    document.body.appendChild(badge);
  }
}

export function updateReceiverUI(percent, speed) {
  const bar = document.getElementById("progress-bar");
  if (bar) bar.style.width = `${percent}%`;

  const statusEl = document.getElementById("status");
  const mode =
    state.dataChannel && state.dataChannel.readyState === "open"
      ? "⚡ P2P"
      : "📡 Relay";
  if (statusEl)
    statusEl.innerText = `Receiving... ${percent}% (${speed} MB/s) [${mode}]`;
}

export function updateSenderUI(percent, speed) {
  const bar = document.getElementById("progress-bar");
  if (bar) bar.style.width = `${percent}%`;

  const statusEl = document.getElementById("status");
  const mode =
    state.dataChannel && state.dataChannel.readyState === "open"
      ? "⚡ P2P"
      : "📡 Relay";
  if (statusEl)
    statusEl.innerText = `Sending... ${percent}% (${speed} MB/s) [${mode}]`;
}
