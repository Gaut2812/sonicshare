export const state = {
  ws: null,
  pc: null,
  dataChannel: null, // Legacy / Default Data Channel
  dataChannels: [], // Parallel Data Channels for Speed
  controlChannel: null, // Unreliable Control Channel
  db: null,

  isConnected: false,
  transferState: "IDLE", // "IDLE", "WAITING", "READY"
  sessionCode: null,

  // File Transfer
  currentFile: null,
  selectedFile: null,
  isInitiator: false,
  isTransferring: false,
  isSending: false,
  isVideoStream: false, // ⚡ New Video Mode
  videoProtocol: null,
  videoScheduler: null,
  credits: 0, // Flow control credits
  transferStartTime: 0,
  currentChunkSize: 512 * 1024, // Adaptive chunk size (start 512KB)
  rttMonitorInterval: null,
  activeChannelIndex: 0, // For round-robin distribution
  _readyNotified: false, // Prevents duplicate notifyTransferReady() from parallel channels
  _keepaliveInterval: null,

  // Transfer Protocol
  nextSeq: 0,
  lastAck: -1,
  expectedSeq: 0,
  inflight: {},
  receivedChunks: [], // Usually empty to save RAM, using DB

  // Memory-Safe File Streaming
  fileOffset: 0, // Current position in file for streaming reads

  // Session Management
  lastActivityTime: Date.now(),
  heartbeatTimer: null,
  sessionTimeoutTimer: null,

  // Retry Management
  chunkRetries: {}, // Track retry count per sequence number

  // Transfer Metrics
  totalBytesTransferred: 0,
  transferSpeed: 0, // bytes per second
  eta: 0, // estimated time remaining in seconds

  // WebRTC Performance Tuning
  rttSamples: [], // Round-trip time samples for dynamic tuning
  chunkSendTimes: {}, // Track when each chunk was sent (for RTT calc)
  lastSentTime: {}, // Track last transmission time per chunk (for retransmission)
  prefetchQueue: [], // Prefetched file chunks for parallel reading
  dynamicWindowSize: 16, // Adjusted based on RTT

  // Crypto
  keyPair: null,
  sharedKey: null,
  remoteHash: null,
  streamingHashState: null, // For progressive hash calculation

  // Helpers
  messageQueue: Promise.resolve(),

  resetTransfer() {
    this.nextSeq = 0;
    this.lastAck = -1;
    this.inflight = {};
    this.isTransferring = true;
    this.isVideoStream = false;
    this.credits = 0;
    this.transferStartTime = Date.now();
    this.fileOffset = 0;
    this.chunkRetries = {};
    this.totalBytesTransferred = 0;
    this.transferSpeed = 0;
    this.eta = 0;
    this.lastActivityTime = Date.now();
    this.rttSamples = [];
    this.chunkSendTimes = {};
    this.prefetchQueue = [];
    this.dynamicWindowSize = 16;
    this.currentChunkSize = 512 * 1024;
    this.activeChannelIndex = 0;
  },

  clear() {
    this.keyPair = null;
    this.sharedKey = null;
    this.remoteHash = null;
    this.currentFile = null;
    this.selectedFile = null;
    this.expectedSeq = 0;
    this.receivedChunks = [];
    this._readyNotified = false;
  },
};
