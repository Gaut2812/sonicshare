// Production-Grade Configuration for 50GB+ Files
export const CHUNK_SIZE = 8 * 1024; // 8 KB - Fixed for maximum browser compatibility
export const WINDOW_SIZE = 32; // Compensate for smaller chunks

// WebRTC Performance Tuning (CRITICAL FOR SPEED)
export const MAX_BUFFER = 4 * 1024 * 1024; // 4 MB - Increased for parallel streams
export const BUFFER_LOW_THRESHOLD = 1024 * 1024; // 1 MB
export const PREFETCH_CHUNKS = 8; // Parallel file reading optimization
export const PARALLEL_FAST_CHANNELS = 6; // Multistream for bandwidth saturation
export const SACK_BATCH_SIZE = 50; // Acknowledge chunks in batches to save overhead

// Dynamic Window Tuning (based on RTT)
export const WINDOW_RTT_THRESHOLDS = {
  EXCELLENT: { rtt: 50, window: 64 }, // <50ms RTT = fiber/LAN
  GOOD: { rtt: 100, window: 32 }, // <100ms RTT = good internet
  NORMAL: { rtt: 200, window: 16 }, // <200ms RTT = normal
  POOR: { rtt: Infinity, window: 8 }, // >200ms RTT = slow/mobile
};

// WebRTC Configuration
export const RTC_CONFIG = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
    { urls: "stun:stun2.l.google.com:19302" },
    { urls: "stun:stun3.l.google.com:19302" },
    { urls: "stun:stun4.l.google.com:19302" },
  ],
};

export const IS_SECURE = window.isSecureContext;

// Advanced Video Optimization Engine Constants
export const VIDEO_CHUNK_MIN = 8 * 1024; // 8 KB - Max compatible
export const VIDEO_CHUNK_MAX = 8 * 1024; // 8 KB
export const FEC_RATIO = 0.1; // 10% Forward Error Correction
export const SCTP_BUFFER_SIZE = 4 * 1024 * 1024; // 4 MB SCTP Buffer

// Connection Constants
export const SESSION_TIMEOUT = 10 * 60 * 1000; // 10 minutes
export const HEARTBEAT_INTERVAL = 30000; // 30 seconds
export const RETRANSMIT_INTERVAL = 1000; // 1 second
export const MAX_RETRIES = 5;
