// Casnt wire protocol (shared by the PC server and the tests).
// Every message on the TCP link is a frame: [type:1 byte][length:4 bytes BE][payload].
'use strict';

const PORT = 47820;            // TCP: control + media
const DISCOVERY_PORT = 47821;  // UDP: "CASNT?" broadcast -> JSON reply
const DISCOVERY_PROBE = 'CASNT?';
const MAX_FRAME = 16 * 1024 * 1024;

const T = Object.freeze({
  JSON: 1,     // UTF-8 JSON control message
  VCONF: 2,    // H.264 codec config (SPS/PPS, Annex B)
  VKEY: 3,     // [pts us: 8 bytes BE] + H.264 key frame (Annex B, config prepended)
  VFRAME: 4,   // [pts us: 8 bytes BE] + H.264 delta frame
  AGAME: 5,    // game audio: PCM s16le, 48 kHz, stereo
  AMIC: 6,     // mic audio: PCM s16le, 48 kHz, mono
});

function encode(type, payload) {
  const header = Buffer.alloc(5);
  header[0] = type;
  header.writeUInt32BE(payload.length, 1);
  return Buffer.concat([header, payload]);
}

function encodeJson(obj) {
  return encode(T.JSON, Buffer.from(JSON.stringify(obj), 'utf8'));
}

class FrameReader {
  constructor(onFrame, onError) {
    this.onFrame = onFrame;
    this.onError = onError || (() => {});
    this.chunks = [];
    this.size = 0;
  }

  push(chunk) {
    this.chunks.push(chunk);
    this.size += chunk.length;
    if (this.size < 5) return;
    let buf = this.chunks.length === 1 ? this.chunks[0] : Buffer.concat(this.chunks);
    let off = 0;
    while (buf.length - off >= 5) {
      const type = buf[off];
      const len = buf.readUInt32BE(off + 1);
      if (len > MAX_FRAME) { this.onError(new Error('frame too large')); this.chunks = []; this.size = 0; return; }
      if (buf.length - off - 5 < len) break;
      const payload = buf.subarray(off + 5, off + 5 + len);
      off += 5 + len;
      try { this.onFrame(type, payload); } catch (e) { this.onError(e); }
    }
    const rest = buf.subarray(off);
    this.chunks = rest.length ? [Buffer.from(rest)] : [];
    this.size = rest.length;
  }
}

// Build a WebCodecs codec string ("avc1.PPCCLL") from Annex B SPS/PPS bytes.
function avcCodecString(config) {
  for (let i = 0; i + 4 < config.length; i++) {
    const three = config[i] === 0 && config[i + 1] === 0 && config[i + 2] === 1;
    if (!three) continue;
    const nal = config[i + 3];
    if ((nal & 0x1f) === 7 && i + 6 < config.length) {
      const hex = (b) => b.toString(16).padStart(2, '0');
      return 'avc1.' + hex(config[i + 4]) + hex(config[i + 5]) + hex(config[i + 6]);
    }
  }
  return 'avc1.640033'; // High profile, level 5.1 fallback
}

module.exports = { PORT, DISCOVERY_PORT, DISCOVERY_PROBE, T, encode, encodeJson, FrameReader, avcCodecString };
