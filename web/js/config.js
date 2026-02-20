// =============================================================================
// Production-Grade Configuration — Large File Optimized (10GB+)
// =============================================================================

// Adaptive Chunk Size (start at 512KB, adjust based on RTT)
export const CHUNK_SIZE = 512 * 1024; // 512 KB default
export const CHUNK_SIZE_MIN = 256 * 1024; // 256 KB floor (bad connections)
export const CHUNK_SIZE_MAX = 1024 * 1024; // 1 MB ceiling (LAN / fiber)
export const WINDOW_SIZE = 32;

// WebRTC Performance Tuning
export const MAX_BUFFER = 8 * 1024 * 1024; // 8 MB — high water mark before backpressure kicks in
export const BUFFER_LOW_THRESHOLD = 4 * 1024 * 1024; // 4 MB — resume sending when below this
export const PREFETCH_CHUNKS = 8;
export const PARALLEL_FAST_CHANNELS = 4; // 4 streams — optimal for browser SCTP
export const SACK_BATCH_SIZE = 50;

// Dynamic Window Tuning (based on RTT)
export const WINDOW_RTT_THRESHOLDS = {
  EXCELLENT: { rtt: 50, window: 64 }, // <50ms RTT = fiber/LAN
  GOOD: { rtt: 100, window: 32 }, // <100ms RTT = good internet
  NORMAL: { rtt: 200, window: 16 }, // <200ms RTT = normal
  POOR: { rtt: Infinity, window: 8 }, // >200ms RTT = slow/mobile
};

// RTT-Based Adaptive Chunk Thresholds (in seconds)
export const RTT_CHUNK_THRESHOLDS = {
  LAN: { maxRTT: 0.05, chunkSize: 1024 * 1024 }, // <50ms  → 1 MB
  FIBER: { maxRTT: 0.1, chunkSize: 768 * 1024 }, // <100ms → 768 KB
  BROADBAND: { maxRTT: 0.2, chunkSize: 512 * 1024 }, // <200ms → 512 KB
  SLOW: { maxRTT: Infinity, chunkSize: 256 * 1024 }, // >200ms → 256 KB
};

// RTT Monitoring
export const RTT_POLL_INTERVAL = 2000; // Check RTT every 2 seconds

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
export const VIDEO_CHUNK_MIN = 512 * 1024;
export const VIDEO_CHUNK_MAX = 1024 * 1024;
export const FEC_RATIO = 0.1;
export const SCTP_BUFFER_SIZE = 8 * 1024 * 1024;

// Connection Constants
export const SESSION_TIMEOUT = 10 * 60 * 1000; // 10 minutes
export const HEARTBEAT_INTERVAL = 30000; // 30 seconds
export const RETRANSMIT_INTERVAL = 1000; // 1 second
export const MAX_RETRIES = 5;
