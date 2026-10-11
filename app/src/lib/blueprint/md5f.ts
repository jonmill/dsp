/**
 * MD5F: the game's modified MD5 (BF §2). Standard MD5 with two changed initial state words
 * (B, D) and eight changed additive constants (K[1,6,12,15,19,21,24,27]); everything else
 * (round functions, message order, shifts, padding, little-endian output) is unchanged.
 */

// prettier-ignore
const K = new Uint32Array([
  0xd76aa478, 0xe8d7b756, 0x242070db, 0xc1bdceee, 0xf57c0faf, 0x4787c62a, 0xa8304623, 0xfd469501,
  0x698098d8, 0x8b44f7af, 0xffff5bb1, 0x895cd7be, 0x6b9f1122, 0xfd987193, 0xa679438e, 0x39b40821,
  0xf61e2562, 0xc040b340, 0x265e5a51, 0xc9b6c7aa, 0xd62f105d, 0x02443453, 0xd8a1e681, 0xe7d3fbc8,
  0x21f1cde6, 0xc33707d6, 0xf4d50d87, 0x475a14ed, 0xa9e3e905, 0xfcefa3f8, 0x676f02d9, 0x8d2a4c8a,
  0xfffa3942, 0x8771f681, 0x6d9d6122, 0xfde5380c, 0xa4beea44, 0x4bdecfa9, 0xf6bb4b60, 0xbebfbc70,
  0x289b7ec6, 0xeaa127fa, 0xd4ef3085, 0x04881d05, 0xd9d4d039, 0xe6db99e5, 0x1fa27cf8, 0xc4ac5665,
  0xf4292244, 0x432aff97, 0xab9423a7, 0xfc93a039, 0x655b59c3, 0x8f0ccc92, 0xffeff47d, 0x85845dd1,
  0x6fa87e4f, 0xfe2ce6e0, 0xa3014314, 0x4e0811a1, 0xf7537e82, 0xbd3af235, 0x2ad7d2bb, 0xeb86d391,
]);

/** Shift per step: S[(i >> 4) * 4 + (i & 3)]. */
const S = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];

// mirrors: MD5F.Compute
/**
 * MD5F of `bytes` as 32 uppercase hex characters. A blueprint's hash is
 * `md5f(utf8(str.slice(0, str.lastIndexOf('"'))))`.
 */
export function md5f(bytes: Uint8Array): string {
  const n = bytes.length;
  const padLen = (((n + 8) >> 6) + 1) << 6; // room for 0x80 + 8-byte bit length
  const buf = new Uint8Array(padLen);
  buf.set(bytes);
  buf[n] = 0x80;
  const dv = new DataView(buf.buffer);
  dv.setUint32(padLen - 8, (n * 8) >>> 0, true); // bit length, low word
  dv.setUint32(padLen - 4, Math.floor(n / 0x20000000), true); // bit length, high word
  let a0 = 0x67452301 | 0;
  let b0 = 0xefdcab89 | 0;
  let c0 = 0x98badcfe | 0;
  let d0 = 0x10325746 | 0;
  for (let off = 0; off < padLen; off += 64) {
    let a = a0;
    let b = b0;
    let c = c0;
    let d = d0;
    for (let i = 0; i < 64; i++) {
      let f: number;
      let g: number;
      if (i < 16) {
        f = (b & c) | (~b & d);
        g = i;
      } else if (i < 32) {
        f = (d & b) | (~d & c);
        g = (5 * i + 1) & 15;
      } else if (i < 48) {
        f = b ^ c ^ d;
        g = (3 * i + 5) & 15;
      } else {
        f = c ^ (b | ~d);
        g = (7 * i) & 15;
      }
      f = (f + a + K[i] + dv.getUint32(off + g * 4, true)) | 0;
      a = d;
      d = c;
      c = b;
      const s = S[(i >> 4) * 4 + (i & 3)];
      b = (b + ((f << s) | (f >>> (32 - s)))) | 0;
    }
    a0 = (a0 + a) | 0;
    b0 = (b0 + b) | 0;
    c0 = (c0 + c) | 0;
    d0 = (d0 + d) | 0;
  }
  const out = new DataView(new ArrayBuffer(16));
  [a0, b0, c0, d0].forEach((v, i) => out.setInt32(i * 4, v, true)); // little-endian words
  let hex = '';
  for (let i = 0; i < 16; i++) hex += out.getUint8(i).toString(16).padStart(2, '0');
  return hex.toUpperCase();
}
