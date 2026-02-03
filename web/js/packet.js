// Binary packet encoding/decoding for WebRTC high-speed transfers
// Uses ArrayBuffer instead of JSON for zero-copy performance

/**
 * Packet Format (Binary):
 * [type (1 byte)][seq (4 bytes)][payloadLength (4 bytes)][payload (N bytes)]
 *
 * For IV-based encryption:
 * [type (1 byte)][seq (4 bytes)][ivLength (4 bytes)][iv (12 bytes)][payloadLength (4 bytes)][payload (N bytes)]
 */

// Packet Types
export const PacketType = {
  DATA: 1,
  ACK: 2,
  KEY: 3,
  HASH: 4,
  START: 5,
  END: 6,
  RESUME: 7,
  VIDEO_DATA: 10,
  SACK: 11,
  FEC: 12,
};

/**
 * Build a binary DATA packet with encrypted payload and IV
 * @param {number} seq - Sequence number
 * @param {ArrayBuffer} iv - Initialization vector (12 bytes for AES-GCM)
 * @param {ArrayBuffer} payload - Encrypted chunk data
 * @returns {ArrayBuffer} Binary packet
 */
export function buildDataPacket(seq, iv, payload) {
  const ivBytes = new Uint8Array(iv);
  const payloadBytes = new Uint8Array(payload);

  // Total: 1 + 4 + 4 + ivLength + 4 + payloadLength
  const totalSize =
    1 + 4 + 4 + ivBytes.byteLength + 4 + payloadBytes.byteLength;
  const buffer = new ArrayBuffer(totalSize);
  const view = new DataView(buffer);

  let offset = 0;

  // Type
  view.setUint8(offset, PacketType.DATA);
  offset += 1;

  // Sequence number
  view.setUint32(offset, seq, false); // Big-endian for network byte order
  offset += 4;

  // IV length
  view.setUint32(offset, ivBytes.byteLength, false);
  offset += 4;

  // IV data
  new Uint8Array(buffer, offset, ivBytes.byteLength).set(ivBytes);
  offset += ivBytes.byteLength;

  // Payload length
  view.setUint32(offset, payloadBytes.byteLength, false);
  offset += 4;

  // Payload data
  new Uint8Array(buffer, offset, payloadBytes.byteLength).set(payloadBytes);

  return buffer;
}

/**
 * Build a binary ACK packet
 * @param {number} seq - Sequence number being acknowledged
 * @returns {ArrayBuffer} Binary packet
 */
export function buildAckPacket(seq) {
  const buffer = new ArrayBuffer(1 + 4); // type + seq
  const view = new DataView(buffer);

  view.setUint8(0, PacketType.ACK);
  view.setUint32(1, seq, false);

  return buffer;
}

/**
 * Parse a binary packet
 * @param {ArrayBuffer} buffer - Raw packet data
 * @returns {Object} Parsed packet
 */
export function parsePacket(buffer) {
  const view = new DataView(buffer);
  let offset = 0;

  // Read type
  const type = view.getUint8(offset);
  offset += 1;

  // Read sequence number
  const seq = view.getUint32(offset, false);
  offset += 4;

  if (type === PacketType.ACK) {
    return { type: "ACK", seq };
  }

  if (type === PacketType.DATA) {
    // Read IV length
    const ivLength = view.getUint32(offset, false);
    offset += 4;

    // Read IV
    const iv = buffer.slice(offset, offset + ivLength);
    offset += ivLength;

    // Read payload length
    const payloadLength = view.getUint32(offset, false);
    offset += 4;

    // Read payload
    const payload = buffer.slice(offset, offset + payloadLength);

    return { type: "DATA", seq, iv, payload };
  }

  if (type === PacketType.VIDEO_DATA) {
    const size = view.getUint32(offset, false);
    offset += 4;
    const fileOffset = view.getUint32(offset, false);
    offset += 4;
    const isLast = view.getUint8(offset) === 1;
    offset += 1;
    const checksum = view.getUint16(offset, false);
    offset += 2;
    // Header is now 1 + 4 + 4 + 4 + 1 + 2 = 16 bytes
    const payload = buffer.slice(offset, offset + size);
    return {
      type: "VIDEO_DATA",
      seq,
      size,
      fileOffset,
      isLast,
      checksum,
      payload,
    };
  }

  if (type === PacketType.SACK) {
    const count = view.getUint32(offset, false);
    offset += 4;
    const ranges = [];
    for (let i = 0; i < count; i++) {
      const start = view.getUint32(offset, false);
      offset += 4;
      const end = view.getUint32(offset, false);
      offset += 4;
      ranges.push({ start, end });
    }
    return { type: "SACK", cumulativeAck: seq, ranges };
  }

  if (type === PacketType.FEC) {
    const len = buffer.byteLength - offset;
    const payload = buffer.slice(offset, offset + len);
    return { type: "FEC", group: seq, payload }; // Seq holds group ID for FEC
  }

  // For other types, return minimal info
  return { type, seq };
}

/**
 * Check if data is likely a binary packet (vs JSON)
 * @param {*} data - Data to check
 * @returns {boolean} True if binary packet
 */
export function isBinaryPacket(data) {
  return data instanceof ArrayBuffer;
}

/**
 * Build a simple control packet (RESUME, END, etc.)
 * @param {string} typeStr - Type string ('RESUME', 'END', etc.)
 * @param {number} seq - Sequence number (optional)
 * @returns {ArrayBuffer} Binary packet
 */
export function buildControlPacket(typeStr, seq = 0) {
  const typeMap = {
    RESUME: PacketType.RESUME,
    END: PacketType.END,
  };

  const buffer = new ArrayBuffer(1 + 4);
  const view = new DataView(buffer);

  view.setUint8(0, typeMap[typeStr] || 0);
  view.setUint32(1, seq, false);

  return buffer;
}

export function buildVideoPacket(seq, payload, isLast, fileOffset) {
  const payloadBytes = new Uint8Array(payload);
  // Header: Type(1) + Seq(4) + Size(4) + Offset(4) + isLast(1) + Checksum(2) = 16 bytes
  const buffer = new ArrayBuffer(16 + payloadBytes.byteLength);
  const view = new DataView(buffer);
  let offset = 0;

  view.setUint8(offset, PacketType.VIDEO_DATA);
  offset += 1;
  view.setUint32(offset, seq, false);
  offset += 4;
  view.setUint32(offset, payloadBytes.byteLength, false);
  offset += 4;
  view.setUint32(offset, fileOffset || 0, false);
  offset += 4;
  view.setUint8(offset, isLast ? 1 : 0);
  offset += 1;

  // Simple Checksum (2 bytes)
  let sum = 0;
  for (let i = 0; i < Math.min(payloadBytes.length, 100); i++) {
    sum = (sum + payloadBytes[i]) & 0xffff;
  }
  view.setUint16(offset, sum, false);
  offset += 2;

  new Uint8Array(buffer, offset).set(payloadBytes);

  return buffer;
}

export function buildSackPacket(cumulativeAck, ranges) {
  const rangeSize = ranges.length * 8;
  const buffer = new ArrayBuffer(1 + 4 + 4 + rangeSize);
  const view = new DataView(buffer);
  let offset = 0;

  view.setUint8(offset, PacketType.SACK);
  offset += 1;
  view.setUint32(offset, cumulativeAck, false);
  offset += 4;
  view.setUint32(offset, ranges.length, false);
  offset += 4;

  for (const r of ranges) {
    view.setUint32(offset, r.start, false);
    offset += 4;
    view.setUint32(offset, r.end, false);
    offset += 4;
  }
  return buffer;
}

export function buildFecPacket(group, payload) {
  const payloadBytes = new Uint8Array(payload);
  const buffer = new ArrayBuffer(1 + 4 + payloadBytes.byteLength);
  const view = new DataView(buffer);

  view.setUint8(0, PacketType.FEC);
  view.setUint32(1, group, false);
  new Uint8Array(buffer, 5).set(payloadBytes);
  return buffer;
}
