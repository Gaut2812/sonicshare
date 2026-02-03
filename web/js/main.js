console.log("🚀 [Main] SonicShare Frontend Booting...");
import { state } from "./state.js";
import { connect, SonicSignaling } from "./network.js";
import { injectLocalModeUI, debugLog } from "./ui.js";
import { sendFile } from "./protocol.js";
import { startWebRTC } from "./webrtc.js";
import { generateKeys } from "./crypto.js";

// Ensure state is globally accessible for HTML if needed
window.sonicState = state;
window.connect = connect;

/**
 * Initiator Flow: Start a new transfer session
 */
window.createSession = async function () {
  console.log("🛠 [UI] Generate Button Clicked");
  state.isInitiator = true;

  try {
    // 1. Generate E2EE Keys (if secure)
    console.log("🔐 [Crypto] Preparing security layer...");
    await generateKeys();

    // 2. Setup WebRTC and Obtain Invite Code
    console.log("🌐 [WebRTC] Initializing PeerConnection & Signaling...");
    await startWebRTC();
  } catch (err) {
    console.error("❌ [Main] Session creation failed:", err);
    debugLog(`❌ Error: ${err.message}`, "var(--error)");
    alert("Full error: " + err.message);
  }
};

/**
 * Receiver Flow: Join an existing session
 */
window.joinSession = async function (code) {
  if (!code || code.length !== 6) {
    alert("Please enter a valid 6-character code.");
    return;
  }

  console.log(`🛠 [UI] Joining Session: ${code}...`);
  state.isInitiator = false;
  state.sessionCode = code;

  try {
    // 1. Initialize Signaling Client
    console.log("📡 [Signaling] Initializing Hybrid Client...");
    state.signaling = new SonicSignaling(code, "receiver");

    // 2. Fetch Offer via REST
    console.log("📨 [Session] Fetching WebRTC Offer...");
    const session = await state.signaling.getSession();

    if (session.error) {
      console.error("❌ [Session] Error:", session.error);
      alert(`Session Error: ${session.error}`);
      return;
    }

    // 3. Setup Security & Handle Offer (Generates Answer)
    console.log("🔐 [Crypto] Preparing security layer...");
    await generateKeys();

    console.log("🌐 [WebRTC] Handling remote offer...");
    const { handleOffer } = await import("./webrtc.js");
    await handleOffer(session.offer);

    // 4. Connect WebSocket for ICE Trickle
    console.log("🔌 [Signaling] Connecting WebSocket tunnel...");
    await state.signaling.connectWebSocket();

    debugLog("✅ Connection request sent", "var(--success)");
  } catch (err) {
    console.error("❌ [Main] Joining failed:", err);
    debugLog(`❌ Error: ${err.message}`, "var(--error)");
  }
};

// Map file helpers
window.sendFile = sendFile;

// Boot
window.addEventListener("load", () => {
  console.log("🏁 [System] Window Load - Initializing UI Components");
  injectLocalModeUI();

  // Verify server availability
  connect(() => {
    console.log("✅ [System] Server Health Check: OK");
  });
});
