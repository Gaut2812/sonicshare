import { state } from "./state.js";
import { debugLog } from "./ui.js";

// network.js - Refactored Signaling Client following User Research Fix 1
export class SonicSignaling {
  constructor(sessionCode, role) {
    this.code = sessionCode;
    this.role = role; // 'sender' or 'receiver'
    this.ws = null;
    // Use the current page's origin (works for both localhost and network access)
    this.baseUrl = window.location.origin;
    // WebSocket URL (http -> ws, https -> wss)
    this.wsUrl = this.baseUrl.replace(/^http/, "ws");

    // Callbacks to be hooked by protocol/webrtc modules
    this.onAnswer = null;
    this.onIceCandidate = null;
    this.onPeerReady = null;
    this.onOffer = null;
  }

  // Use REST API for initial SDP exchange (reliable)
  async createSession(offer) {
    const response = await fetch(`${this.baseUrl}/api/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        code: this.code,
        sdp: offer.sdp,
        type: offer.type,
      }),
    });
    const result = await response.json();
    if (result.code) {
      state.sessionCode = result.code;
      this.code = result.code;
    }
    return result;
  }

  async getSession() {
    const response = await fetch(`${this.baseUrl}/api/session/${this.code}`);
    return await response.json();
  }

  async postAnswer(answer) {
    const response = await fetch(
      `${this.baseUrl}/api/session/${this.code}/answer`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sdp: answer.sdp,
          type: answer.type,
        }),
      },
    );
    return await response.json();
  }

  // WebSocket only for ICE candidates and status updates
  async connectWebSocket() {
    return new Promise((resolve, reject) => {
      const wsUrl = `${this.wsUrl}/ws/${this.code}/${this.role}`;

      console.log(
        `[Signaling] Connecting WS for ${this.role} on ${this.code}...`,
      );
      this.ws = new WebSocket(wsUrl);
      state.ws = this.ws; // Maintain global state reference

      this.ws.onopen = () => {
        console.log("[Signaling] WebSocket connected");
        state.isConnected = true;
        resolve();
      };

      this.ws.onerror = (e) => {
        console.error("[Signaling] WebSocket error:", e);
        reject(e);
      };

      this.ws.onclose = () => {
        console.log("[Signaling] WebSocket closed");
        state.isConnected = false;
        // Auto-reconnect after 3 seconds if not completed
        if (state.transferState !== "COMPLETED") {
          setTimeout(() => this.connectWebSocket(), 3000);
        }
      };

      this.ws.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        // console.log("[Signaling] Received:", msg.type);

        switch (msg.type) {
          case "answer":
            if (this.onAnswer) this.onAnswer(msg.answer);
            // Fallback for legacy protocol.js
            import("./protocol.js").then((m) =>
              m.handleMessage({ type: "ANSWER", payload: msg.answer }),
            );
            break;
          case "offer":
            if (this.onOffer) this.onOffer(msg.offer);
            import("./protocol.js").then((m) =>
              m.handleMessage({ type: "OFFER", payload: msg.offer }),
            );
            break;
          case "ice_candidate":
            if (this.onIceCandidate) this.onIceCandidate(msg.candidate);
            import("./protocol.js").then((m) =>
              m.handleMessage({ type: "ICE", payload: msg.candidate }),
            );
            break;
          case "peer_ready":
            if (this.onPeerReady) this.onPeerReady();
            import("./protocol.js").then((m) =>
              m.handleMessage({ type: "READY", code: this.code }),
            );
            break;
          case "ping":
            if (this.ws.readyState === WebSocket.OPEN) {
              this.ws.send(JSON.stringify({ type: "pong" }));
            }
            break;
        }
      };
    });
  }

  async postIceCandidate(candidate) {
    try {
      await fetch(`${this.baseUrl}/api/session/${this.code}/ice`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          candidate: candidate,
          role: this.role,
        }),
      });
    } catch (e) {
      console.warn("[Signaling] Failed to post ICE via REST", e);
    }
  }

  sendIceCandidate(candidate) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(
        JSON.stringify({
          type: "ice_candidate",
          candidate: candidate,
        }),
      );
    } else {
      this.postIceCandidate(candidate);
    }
  }

  notifyTransferReady() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: "transfer_ready" }));
    }
  }

  notifyTransferComplete() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: "transfer_complete" }));
    }
  }
}

// Global instance for convenience
state.signaling = null;

export async function connect(onConnected) {
  // Legacy wrapper - now just ensures we can talk to session API
  const response = await fetch(`${window.location.origin}/api/health`);
  if (response.ok) {
    state.isConnected = true;
    if (onConnected) onConnected();
  }
}

export function sendData(msg) {
  const json = typeof msg === "string" ? msg : JSON.stringify(msg);

  if (state.dataChannel && state.dataChannel.readyState === "open") {
    try {
      state.dataChannel.send(json);
      return;
    } catch (e) {
      console.warn("WebRTC Send Failed.", e);
    }
  }

  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    state.ws.send(json);
  }
}
