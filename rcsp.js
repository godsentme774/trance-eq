/*
 * Jieli RCSP protocol pieces needed to read and write the equalizer on
 * Audionic earbuds (Trance 850). Everything here was reconstructed from the
 * Audionic Suite 1.0.3 APK (decompiled Java plus the ARM native library
 * libjl_bluetooth.so). See ../Audionic EQ/PROTOCOL.md for the evidence.
 *
 * Plain JS, no dependencies, runs in the browser and in Node (for tests).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Rcsp = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---------------------------------------------------------------- hex
  function toHex(b) {
    return Array.from(b, (x) => (x & 255).toString(16).padStart(2, '0')).join('');
  }
  function fromHex(s) {
    s = s.replace(/[^0-9a-f]/gi, '');
    const out = new Uint8Array(s.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(s.substr(i * 2, 2), 16);
    return out;
  }

  // ------------------------------------------------- SAFER+ / Bluetooth E1
  // The official app authenticates the earbuds with the Bluetooth legacy
  // authentication function E1 (SAFER+ based), using a key and a 6 byte
  // address that are constants baked into libjl_bluetooth.so.
  const AUTH_KEY = fromHex('06775f87918dd423005df1d8cf0c142b');
  const AUTH_ADDR = fromHex('112233332211');

  const EXP = new Uint8Array(256);
  const LOG = new Uint8Array(256);
  (function () {
    let v = 1;
    for (let i = 0; i < 256; i++) {
      EXP[i] = v & 255;
      LOG[EXP[i]] = i;
      v = (v * 45) % 257;
    }
  })();
  const SHUFFLE = [8, 11, 12, 15, 2, 1, 6, 5, 10, 9, 14, 13, 0, 7, 4, 3];
  const XOR_POS = new Set([0, 3, 4, 7, 8, 11, 12, 15]);

  const rotl3 = (b) => ((b << 3) | (b >> 5)) & 255;

  function keySchedule(key) {
    const cur = Array.from(key);
    cur.push(0);
    for (let i = 0; i < 16; i++) cur[16] ^= key[i];
    const ks = [Array.from(key)];
    for (let p = 2; p <= 17; p++) {
      for (let i = 0; i < 17; i++) cur[i] = rotl3(cur[i]);
      const k = [];
      for (let i = 0; i < 16; i++) {
        const bias = EXP[EXP[(17 * p + i + 1) & 255]];
        k.push((cur[(i + p - 1) % 17] + bias) & 255);
      }
      ks.push(k);
    }
    return ks;
  }

  function linearLayer(x) {
    for (let l = 0; l < 4; l++) {
      const y = new Array(16);
      for (let i = 0; i < 16; i += 2) {
        y[i] = (2 * x[i] + x[i + 1]) & 255;
        y[i + 1] = (x[i] + x[i + 1]) & 255;
      }
      x = y;
      if (l < 3) x = SHUFFLE.map((s) => x[s]);
    }
    return x;
  }

  // Ar when prime is false, Ar' (round 3 also adds the cipher input) when true.
  function saferAr(input, ks, prime) {
    let x = Array.from(input);
    const first = Array.from(input);
    for (let r = 0; r < 8; r++) {
      if (prime && r === 2) {
        x = x.map((v, i) => (XOR_POS.has(i) ? v ^ first[i] : (v + first[i]) & 255));
      }
      const k1 = ks[2 * r];
      const k2 = ks[2 * r + 1];
      x = x.map((v, i) => (XOR_POS.has(i) ? v ^ k1[i] : (v + k1[i]) & 255));
      x = x.map((v, i) => (XOR_POS.has(i) ? EXP[v] : LOG[v]));
      x = x.map((v, i) => (XOR_POS.has(i) ? (v + k2[i]) & 255 : v ^ k2[i]));
      x = linearLayer(x);
    }
    const k = ks[16];
    return x.map((v, i) => (XOR_POS.has(i) ? v ^ k[i] : (v + k[i]) & 255));
  }

  const KEY_OFFSETS = [233, 229, 223, 193, 179, 167, 149, 131, 233, 229, 223, 193, 179, 167, 149, 131];

  function e1(addr, rand, key) {
    const x = saferAr(rand, keySchedule(key), false);
    const y = x.map((v, i) => ((v ^ rand[i]) + addr[i % 6]) & 255);
    const kt = Array.from(key, (v, i) => {
      const add = i < 8 ? i % 2 === 0 : i % 2 === 1;
      return add ? (v + KEY_OFFSETS[i]) & 255 : v ^ KEY_OFFSETS[i];
    });
    return Uint8Array.from(saferAr(y, keySchedule(kt), true));
  }

  // 16 byte challenge -> 17 byte answer [0x01, E1(challenge)]
  function authAnswer(challenge16) {
    const out = new Uint8Array(17);
    out[0] = 1;
    out.set(e1(AUTH_ADDR, challenge16, AUTH_KEY), 1);
    return out;
  }

  const AUTH_RESET_FRAME = fromHex('FEDCBAC00600020001EF');
  const AUTH_PASS = Uint8Array.from([2, 0x70, 0x61, 0x73, 0x73]);

  function isAuthData(b) {
    return (b.length === 5 && b[0] === 2) || (b.length === 17 && (b[0] === 0 || b[0] === 1));
  }

  // Mutual authentication, mirrors RcspAuth.handleAuthData in the official app.
  class AuthSession {
    constructor(send, onDone) {
      this.send = send; // async (Uint8Array) => void, raw GATT write
      this.onDone = onDone; // (ok, reason) => void
      this.progress = false;
      this.done = false;
      this.myRand = null;
    }
    async start() {
      this.myRand = new Uint8Array(17);
      this.myRand[0] = 0;
      const r = new Uint8Array(16);
      (globalThis.crypto || require('crypto').webcrypto).getRandomValues(r);
      this.myRand.set(r, 1);
      await this.send(AUTH_RESET_FRAME);
      await new Promise((res) => setTimeout(res, 50));
      await this.send(this.myRand);
    }
    async handle(b) {
      if (this.done || !isAuthData(b)) return;
      if (this.progress) {
        if (b.length === 17 && b[0] === 0) {
          await this.send(authAnswer(b.subarray(1)));
        } else if (b.length >= 5 && toHex(b.subarray(0, 5)) === toHex(AUTH_PASS)) {
          this.done = true;
          this.onDone(true);
        }
      } else if (b.length === 17 && b[0] === 1) {
        const want = authAnswer(this.myRand.subarray(1));
        if (toHex(want) === toHex(b)) {
          await this.send(AUTH_PASS);
          this.progress = true;
        } else {
          this.done = true;
          this.onDone(false, 'earbuds answered the challenge wrongly');
        }
      }
    }
  }

  // ------------------------------------------------------------- framing
  const OP_GET_SYS_INFO = 7;
  const OP_SET_SYS_INFO = 8;
  const OP_SYS_INFO_AUTO_UPDATE = 9;

  // FE DC BA | flag | opcode | len(2, big endian) | payload | EF
  // flag 0x80 = command, 0x40 = a response is wanted. payload = sn + params.
  function frameCommand(opcode, sn, params) {
    const payload = new Uint8Array(1 + params.length);
    payload[0] = sn & 255;
    payload.set(params, 1);
    const out = new Uint8Array(payload.length + 8);
    out.set([0xfe, 0xdc, 0xba, 0xc0, opcode, (payload.length >> 8) & 255, payload.length & 255]);
    out.set(payload, 7);
    out[out.length - 1] = 0xef;
    return out;
  }

  // Splits a stream of notifications into packets. Responses have
  // payload [status, sn, ...data]; commands from the device [sn, ...data].
  class FrameParser {
    constructor() {
      this.buf = [];
    }
    get pending() {
      return this.buf.length > 0;
    }
    push(bytes) {
      for (const x of bytes) this.buf.push(x);
      const out = [];
      for (;;) {
        let i = 0;
        while (i + 2 < this.buf.length && !(this.buf[i] === 0xfe && this.buf[i + 1] === 0xdc && this.buf[i + 2] === 0xba)) i++;
        if (i > 0) this.buf.splice(0, i);
        if (this.buf.length < 7) break;
        const len = (this.buf[5] << 8) | this.buf[6];
        if (this.buf.length < 8 + len) break;
        if (this.buf[7 + len] !== 0xef) {
          this.buf.splice(0, 3);
          continue;
        }
        const flag = this.buf[3];
        const opcode = this.buf[4];
        const payload = Uint8Array.from(this.buf.slice(7, 7 + len));
        this.buf.splice(0, 8 + len);
        const isCommand = (flag & 0x80) !== 0;
        out.push({
          isCommand,
          wantsResponse: (flag & 0x40) !== 0,
          opcode,
          status: isCommand ? 0 : payload[0],
          sn: isCommand ? payload[0] : payload[1],
          data: payload.subarray(isCommand ? 1 : 2),
        });
      }
      return out;
    }
  }

  // --------------------------------------------------------------- sys info
  const ATTR_EQ = 4;
  const ATTR_EQ_PRESETS = 12;
  const FUNC_PUBLIC = 0xff;

  function buildGetEq(sn) {
    // function 0xFF, mask 0x1010 = EQ value (0x10) + EQ presets/frequencies (0x1000)
    return frameCommand(OP_GET_SYS_INFO, sn, Uint8Array.from([FUNC_PUBLIC, 0, 0, 0x10, 0x10]));
  }

  function buildSetEq(sn, mode, gains, dynamic) {
    let attr;
    if (dynamic) {
      attr = new Uint8Array(2 + gains.length);
      attr[0] = (mode | 0x80) & 255;
      attr[1] = gains.length;
      attr.set(gains.map((g) => g & 255), 2);
    } else {
      attr = new Uint8Array(11);
      attr[0] = mode & 255;
      attr.set(gains.slice(0, 10).map((g) => g & 255), 1);
    }
    const params = new Uint8Array(1 + 2 + attr.length);
    params[0] = FUNC_PUBLIC;
    params[1] = attr.length + 1;
    params[2] = ATTR_EQ;
    params.set(attr, 3);
    return frameCommand(OP_SET_SYS_INFO, sn, params);
  }

  // data = [function, (len, type, ...bytes)*]
  function parseAttrs(data) {
    const attrs = [];
    let i = 1;
    while (i < data.length) {
      const len = data[i];
      if (len < 1 || i + 1 + len > data.length) break;
      attrs.push({ type: data[i + 1], data: data.subarray(i + 2, i + 1 + len) });
      i += 1 + len;
    }
    return attrs;
  }

  const s8 = (b) => (b > 127 ? b - 256 : b);

  function parseEqAttr(a) {
    const b0 = a.data[0];
    const dynamic = (b0 & 0x80) !== 0;
    const mode = b0 & 0x7f;
    let gains;
    if (dynamic) gains = Array.from(a.data.subarray(2, 2 + a.data[1]), s8);
    else gains = Array.from(a.data.subarray(1, 11), s8);
    return { mode, dynamic, gains };
  }

  function parseEqPresets(a) {
    const d = a.data;
    const n = d[0];
    const freqs = [];
    let i = 1;
    for (let k = 0; k < n; k++, i += 2) freqs.push((d[i] << 8) | d[i + 1]);
    const presets = [];
    for (let k = 0; k < 7 && i + n < d.length + 1; k++, i += n + 1) {
      if (i + n >= d.length + 1) break;
      presets.push({ mode: d[i] & 0x7f, dynamic: (d[i] & 0x80) !== 0, gains: Array.from(d.subarray(i + 1, i + 1 + n), s8) });
    }
    return { count: n, freqs, presets };
  }

  // Convenience: pull EQ state out of a get/update sys-info packet.
  function readEq(packet) {
    const res = {};
    for (const a of parseAttrs(packet.data)) {
      if (a.type === ATTR_EQ) res.eq = parseEqAttr(a);
      else if (a.type === ATTR_EQ_PRESETS) res.presets = parseEqPresets(a);
    }
    return res;
  }

  return {
    toHex, fromHex,
    e1, authAnswer, AuthSession, isAuthData, AUTH_KEY, AUTH_ADDR, AUTH_RESET_FRAME, AUTH_PASS,
    frameCommand, FrameParser,
    OP_GET_SYS_INFO, OP_SET_SYS_INFO, OP_SYS_INFO_AUTO_UPDATE,
    buildGetEq, buildSetEq, parseAttrs, parseEqAttr, parseEqPresets, readEq,
    MODE_CUSTOM: 6,
  };
});
