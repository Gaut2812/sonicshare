// =============================================================================
// Production-Grade Configuration — Large File Optimized (10GB+)
// =============================================================================

// Adaptive Chunk Size — conservative for internet stability
export const CHUNK_SIZE = 256 * 1024; // 256 KB default
export const CHUNK_SIZE_MIN = 128 * 1024; // 128 KB floor
export const CHUNK_SIZE_MAX = 512 * 1024; // 512 KB ceiling (NOT 1MB on WAN)
export const WINDOW_SIZE = 32;

// WebRTC Performance Tuning (Internet-Stable)
export const MAX_BUFFER = 4 * 1024 * 1024; // 4 MB strict ceiling
export const BUFFER_LOW_THRESHOLD = 2 * 1024 * 1024; // 2 MB resume threshold
export const PREFETCH_CHUNKS = 4;
export const PARALLEL_FAST_CHANNELS = 2; // 2 channels — safer for WAN
export const SACK_BATCH_SIZE = 50;

// Keepalive to prevent NAT UDP mapping expiry
export const KEEPALIVE_INTERVAL = 5000; // ping every 5 seconds

// Dynamic Window Tuning (based on RTT)
export const WINDOW_RTT_THRESHOLDS = {
  EXCELLENT: { rtt: 50, window: 64 }, // <50ms RTT = fiber/LAN
  GOOD: { rtt: 100, window: 32 }, // <100ms RTT = good internet
  NORMAL: { rtt: 200, window: 16 }, // <200ms RTT = normal
  POOR: { rtt: Infinity, window: 8 }, // >200ms RTT = slow/mobile
};

// RTT-Based Adaptive Chunk Thresholds (in seconds)
// Conservative ceiling of 512KB — don't go to 1MB on internet
export const RTT_CHUNK_THRESHOLDS = {
  LAN: { maxRTT: 0.05, chunkSize: 512 * 1024 }, // <50ms  → 512 KB max
  FIBER: { maxRTT: 0.1, chunkSize: 384 * 1024 }, // <100ms → 384 KB
  BROADBAND: { maxRTT: 0.2, chunkSize: 256 * 1024 }, // <200ms → 256 KB
  SLOW: { maxRTT: Infinity, chunkSize: 128 * 1024 }, // >200ms → 128 KB
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
export const HEARTBEAT_INTERVAL = 30000; // 30 seconds (signaling)
export const RETRANSMIT_INTERVAL = 1000; // 1 second
export const MAX_RETRIES = 5;
