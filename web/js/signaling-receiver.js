// signaling-receiver.js - Receiver-specific signaling
export class SonicSignaling {
  constructor(code, role) {
    this.code = code;
    this.role = role;
    this.ws = null;
    this.baseUrl = window.location.origin;
    this.wsUrl = this.baseUrl.replace(/^http/, "ws");
    this.reconnectAttempts = 0;
    this.maxReconnects = 5;
  }

  async getSession() {
    const response = await fetch(`${this.baseUrl}/api/session/${this.code}`);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
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
    if (!response.ok) {
      throw new Error("Failed to send answer");
    }
    return await response.json();
  }

  connectWebSocket() {
    return new Promise((resolve, reject) => {
      const wsUrl = `${this.wsUrl}/ws/${this.code}/${this.role}`;

      console.log("[Signaling] Connecting to:", wsUrl);

      this.ws = new WebSocket(wsUrl);

      this.ws.onopen = () => {
        console.log("[Signaling] WebSocket connected");
        this.reconnectAttempts = 0;
        resolve();
      };

      this.ws.onerror = (e) => {
        console.error("[Signaling] WebSocket error:", e);
        reject(e);
      };

      this.ws.onclose = (e) => {
        console.log("[Signaling] WebSocket closed:", e.code, e.reason);

        // Auto-reconnect if not closed cleanly and under max attempts
        if (e.code !== 1000 && this.reconnectAttempts < this.maxReconnects) {
          this.reconnectAttempts++;
          console.log(
            `[Signaling] Reconnecting... (${this.reconnectAttempts}/${this.maxReconnects})`,
          );
          setTimeout(() => this.connectWebSocket().catch(() => {}), 2000);
        }
      };

      this.ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          this.handleMessage(msg);
        } catch (e) {
          console.error("[Signaling] Failed to parse message:", e);
        }
      };
    });
  }

  handleMessage(msg) {
    console.log("[Signaling] Received:", msg.type);

    switch (msg.type) {
      case "ice_candidate":
        if (this.onIceCandidate) {
          this.onIceCandidate(msg.candidate);
        }
        break;
      case "peer_ready":
        if (this.onPeerReady) {
          this.onPeerReady();
        }
        break;
      case "answer":
        if (this.onAnswer) {
          this.onAnswer(msg.answer);
        }
        break;
      case "ping":
        this.ws.send(JSON.stringify({ type: "pong" }));
        break;
      case "error":
        console.error("[Signaling] Server error:", msg.message);
        break;
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
    }
  }

  notifyTransferReady() {
    this.send({ type: "transfer_ready" });
  }

  notifyTransferComplete() {
    this.send({ type: "transfer_complete" });
  }

  send(msg) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  disconnect() {
    if (this.ws) {
      this.ws.close(1000, "Transfer complete");
    }
  }
}
