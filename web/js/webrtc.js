import { state } from "./state.js";
import {
  RTC_CONFIG,
  MAX_BUFFER,
  BUFFER_LOW_THRESHOLD,
  PARALLEL_FAST_CHANNELS,
  RTT_POLL_INTERVAL,
  RTT_CHUNK_THRESHOLDS,
  KEEPALIVE_INTERVAL,
} from "./config.js";
import { debugLog } from "./ui.js";

/**
 * Production-Grade WebRTC Setup with Speed Optimizations
 */

export async function startWebRTC() {
  console.log("🚀 [WebRTC] Starting WebRTC Setup...");

  const config = {
    ...RTC_CONFIG,
    bundlePolicy: "max-bundle",
    rtcpMuxPolicy: "require",
  };
  state.pc = new RTCPeerConnection(config);

  // Track connection quality for performance tuning
  state.pc.oniceconnectionstatechange = () => {
    console.log("🌐 [ICE] State Changed:", state.pc.iceConnectionState);

    if (state.pc.iceConnectionState === "connected") {
      debugLog("✅ WebRTC Connected", "var(--success)");

      state.pc.getStats().then((stats) => {
        stats.forEach((report) => {
          if (
            report.type === "candidate-pair" &&
            report.state === "succeeded"
          ) {
            const isRelay = report.remoteCandidateId?.includes("relay");
            if (isRelay) {
              debugLog(
                "📡 Using TURN relay (slower but reliable)",
                "var(--text-secondary)",
              );
            } else {
              debugLog("⚡ Direct P2P connection (fastest)", "var(--success)");
            }
          }
        });
      });

      // Start RTT Monitoring for Adaptive Chunks
      startRTTMonitor();
      // Start keepalive pings to prevent NAT timeout
      startKeepalive();
    } else if (
      state.pc.iceConnectionState === "disconnected" ||
      state.pc.iceConnectionState === "failed"
    ) {
      stopRTTMonitor();
      stopKeepalive();
    }
  };

  state.pc.onicecandidate = (event) => {
    if (event.candidate) {
      const c = event.candidate;
      console.log(`🧊 [ICE] Candidate: [${c.type}] ${c.address}:${c.port}`);

      if (state.signaling) {
        state.signaling.sendIceCandidate(event.candidate);
      } else {
        console.warn("⚠️ [ICE] Candidate generated but signaling not ready!");
      }
    }
  };

  state.pc.onconnectionstatechange = () => {
    console.log("🌐 [WebRTC] State Changed:", state.pc.connectionState);
    if (state.pc.connectionState === "connected") {
      debugLog("✅ Peer connected over Internet (WebRTC)", "var(--success)");
    } else if (
      state.pc.connectionState === "failed" ||
      state.pc.connectionState === "disconnected"
    ) {
      debugLog("⚠️ WebRTC disconnected.", "var(--error)");
    }
  };

  if (state.isInitiator) {
    console.log("🛠 [Initiator] Creating Dual Data Channels...");

    // 1. CONTROL CHANNEL — ordered for reliability
    state.controlChannel = state.pc.createDataChannel("control", {
      ordered: true,
    });
    setupControlChannel(state.controlChannel);

    // 2. PARALLEL DATA CHANNELS
    // ordered:true = no SCTP collapse on internet; maxRetransmits removed
    state.dataChannels = [];
    for (let i = 0; i < PARALLEL_FAST_CHANNELS; i++) {
      const label = `fast-${i}`;
      const dc = state.pc.createDataChannel(label, {
        ordered: true, // ← KEY CHANGE: reliable for internet stability
        priority: "high",
      });
      dc.binaryType = "arraybuffer";
      setupDataChannel(dc);
      state.dataChannels.push(dc);

      // Keep first one as legacy dataChannel for compatibility
      if (i === 0) state.dataChannel = dc;
    }

    // ⚡ Initialize Signaling EARLY to catch ICE candidates
    console.log("📡 [Signaling] Pre-initializing Client...");
    const { SonicSignaling } = await import("./network.js");
    state.signaling = new SonicSignaling(state.sessionCode, "sender");

    const offer = await state.pc.createOffer();
    const optimizedSdp = optimizeSDPForHighThroughput(offer.sdp);
    const optimizedOffer = { type: offer.type, sdp: optimizedSdp };

    await state.pc.setLocalDescription(optimizedOffer);

    console.log("📤 [Session] Creating WebRTC Session (REST Offer)...");
    try {
      const result = await state.signaling.createSession(optimizedOffer);
      console.log("📥 [Session] Response Received:", result);

      if (result.error) {
        debugLog(`❌ Session Error: ${result.error}`, "var(--error)");
        return;
      }

      state.sessionCode = result.code;
      console.log(`✅ [Session] Code Assigned: ${result.code}`);

      if (document.getElementById("invite-code")) {
        document.getElementById("invite-code").innerText = result.code;
        console.log("✨ [UI] Invite code displayed.");
      } else {
        console.error("❌ [UI] Element 'invite-code' not found!");
      }

      console.log("🔌 [Signaling] Connecting WebSocket...");
      await state.signaling.connectWebSocket();
    } catch (e) {
      console.error("❌ [Session] Creation Critical Failure:", e);
      debugLog(`❌ Connection Failed: ${e.message}`, "var(--error)");
    }
  } else {
    state.pc.ondatachannel = (event) => {
      const channel = event.channel;
      console.log(`📥 [DataChannel] Received: ${channel.label}`);

      if (channel.label === "control") {
        state.controlChannel = channel;
        setupControlChannel(channel);
      } else if (
        channel.label === "file" ||
        channel.label.startsWith("fast-")
      ) {
        // Multi-channel support for receiver
        if (!state.dataChannels) state.dataChannels = [];
        state.dataChannels.push(channel);
        state.dataChannel = channel; // Backward compatibility
        setupDataChannel(channel);
      }
    };
  }
}

function setupControlChannel(channel) {
  channel.onopen = () => console.log("✅ [Control] Channel OPEN");
  channel.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      import("./protocol.js").then(({ handleMessage }) => {
        handleMessage(msg);
      });
    } catch (e) {}
  };
}

function setupDataChannel(channel) {
  channel.binaryType = "arraybuffer";

  channel.onopen = () => {
    console.log("✅ [File] Channel OPEN");

    const checkReadiness = () => {
      if (channel.readyState !== "open") return;

      const isIceReady =
        state.pc.iceConnectionState === "connected" ||
        state.pc.iceConnectionState === "completed";

      if (!isIceReady) {
        console.warn("⚠️ [File] DC open but ICE pending. Retrying...");
        setTimeout(checkReadiness, 500);
        return;
      }

      channel._isStable = true;
      console.log("✅ [File] Channel STABLE");
      channel.bufferedAmountLowThreshold = BUFFER_LOW_THRESHOLD; // Use value from config (4MB)
      debugLog("⚡ Connection Ready", "var(--success)");

      // [Issue 1 Fix] Notify signaling that we are ready to transfer (triggers READY)
      if (state.signaling) {
        state.signaling.notifyTransferReady();
      }
    };

    setTimeout(checkReadiness, 1000);
  };

  channel.onbufferedamountlow = () => {
    if (state.isTransferring && !state.isSending) {
      import("./protocol.js").then(({ trySendWebRTC }) => {
        if (trySendWebRTC) trySendWebRTC();
      });
    }
  };

  channel.onclose = () => {
    console.error("❌ [File] Channel CLOSED");
    debugLog("❌ Connection Closed", "var(--error)");
    channel._isStable = false;
  };

  channel.onerror = (e) => console.error("❌ [DataChannel] Error:", e);

  channel.onmessage = (event) => {
    if (event.data instanceof ArrayBuffer) {
      import("./protocol.js").then(({ handleBinaryPacket }) => {
        handleBinaryPacket(event.data);
      });
    } else if (typeof event.data === "string") {
      try {
        const msg = JSON.parse(event.data);
        import("./protocol.js").then(({ handleMessage }) => {
          handleMessage(msg);
        });
      } catch (e) {}
    }
  };
}

export function canSendOnWebRTC() {
  const channels =
    state.dataChannels.length > 0 ? state.dataChannels : [state.dataChannel];
  // Check if at least one channel has space
  return channels.some(
    (dc) => dc && dc.readyState === "open" && dc.bufferedAmount < MAX_BUFFER,
  );
}

export function sendBinaryData(data) {
  const channels = state.dataChannels.filter(
    (dc) => dc && dc.readyState === "open" && dc.bufferedAmount < MAX_BUFFER,
  );
  if (channels.length === 0) return false;

  // Pick least busy channel (primitive load balancing)
  const bestDC = channels.sort(
    (a, b) => a.bufferedAmount - b.bufferedAmount,
  )[0];

  try {
    bestDC.send(data);
    return true;
  } catch (e) {
    console.error("Binary send failed:", e);
    return false;
  }
}

export async function handleOffer(offer) {
  if (!state.pc) await startWebRTC();
  console.log("📨 [WebRTC] Received OFFER");
  await state.pc.setRemoteDescription(offer);

  const answer = await state.pc.createAnswer();
  const optimizedSdp = optimizeSDPForHighThroughput(answer.sdp);
  const optimizedAnswer = { type: answer.type, sdp: optimizedSdp };

  await state.pc.setLocalDescription(optimizedAnswer);

  console.log("📤 [Session] Sending ANSWER (REST)...");
  if (state.signaling) {
    await state.signaling.postAnswer(optimizedAnswer);
  }
}

export async function handleAnswer(answer) {
  console.log("📨 [WebRTC] Received ANSWER");
  await state.pc.setRemoteDescription(answer);
}

export async function handleCandidate(candidate) {
  try {
    if (state.pc) {
      await state.pc.addIceCandidate(candidate);
    }
  } catch (e) {
    console.error("❌ [ICE] Error adding candidate:", e);
  }
}

function optimizeSDPForHighThroughput(sdp) {
  let optimized = sdp;
  if (!optimized.includes("transport-wide-cc-extensions")) {
    optimized = optimized.replace(
      /a=mid:data\r?\n/g,
      "a=mid:data\r\na=extmap:3 http://www.ietf.org/id/draft-holmer-rmcat-transport-wide-cc-extensions-01\r\n",
    );
  }
  if (optimized.includes("a=max-message-size")) {
    optimized = optimized.replace(
      /a=max-message-size:\d+/g,
      "a=max-message-size:262144",
    );
  } else {
    optimized += "a=max-message-size:262144\r\n";
  }
  return optimized;
}

/**
 * Adaptive Chunk Size Logic
 */
export function startRTTMonitor() {
  if (state.rttMonitorInterval) return;
  console.log("📊 [WebRTC] Starting RTT Monitor...");

  state.rttMonitorInterval = setInterval(async () => {
    if (!state.pc) return;

    try {
      const stats = await state.pc.getStats();
      stats.forEach((report) => {
        if (report.type === "candidate-pair" && report.state === "succeeded") {
          const rtt = report.currentRoundTripTime; // seconds
          if (rtt !== undefined) {
            adjustAdaptiveChunkSize(rtt);
          }
        }
      });
    } catch (e) {
      console.warn("Failed to get RTC stats:", e);
    }
  }, RTT_POLL_INTERVAL);
}

export function stopRTTMonitor() {
  if (state.rttMonitorInterval) {
    clearInterval(state.rttMonitorInterval);
    state.rttMonitorInterval = null;
    console.log("📊 [WebRTC] RTT Monitor stopped");
  }
}

function adjustAdaptiveChunkSize(rtt) {
  let newSize = state.currentChunkSize;

  if (rtt < RTT_CHUNK_THRESHOLDS.LAN.maxRTT) {
    newSize = RTT_CHUNK_THRESHOLDS.LAN.chunkSize;
  } else if (rtt < RTT_CHUNK_THRESHOLDS.FIBER.maxRTT) {
    newSize = RTT_CHUNK_THRESHOLDS.FIBER.chunkSize;
  } else if (rtt < RTT_CHUNK_THRESHOLDS.BROADBAND.maxRTT) {
    newSize = RTT_CHUNK_THRESHOLDS.BROADBAND.chunkSize;
  } else {
    newSize = RTT_CHUNK_THRESHOLDS.SLOW.chunkSize;
  }

  if (newSize !== state.currentChunkSize) {
    console.log(
      `📊 [Adaptive] Network RTT: ${(rtt * 1000).toFixed(1)}ms → Chunk: ${newSize / 1024}KB`,
    );
    state.currentChunkSize = newSize;
  }
}

/**
 * Keepalive — prevents NAT from closing UDP port mapping during transfer
 */
export function startKeepalive() {
  if (state._keepaliveInterval) return;
  console.log("💓 [WebRTC] Keepalive started");

  state._keepaliveInterval = setInterval(() => {
    const ch = state.controlChannel;
    if (ch && ch.readyState === "open") {
      try {
        ch.send(JSON.stringify({ type: "ping" }));
      } catch (e) {
        // Ignore send errors during teardown
      }
    }
  }, KEEPALIVE_INTERVAL);
}

export function stopKeepalive() {
  if (state._keepaliveInterval) {
    clearInterval(state._keepaliveInterval);
    state._keepaliveInterval = null;
    console.log("💓 [WebRTC] Keepalive stopped");
  }
}
