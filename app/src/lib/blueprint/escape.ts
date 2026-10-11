/** Header text escaping: the game uses `Uri.EscapeDataString` / `Uri.UnescapeDataString` (BF §1.3). */

const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;

/**
 * RFC 3986 escaping: only `A-Z a-z 0-9 - _ . ~` stay literal, everything else is uppercase-hex
 * percent-encoded UTF-8. Stricter than `encodeURIComponent`, which leaves `! ' ( ) *` alone.
 * Lone surrogates become U+FFFD (as in .NET) instead of throwing.
 */
export function escapeDataString(s: string): string {
  return encodeURIComponent(s.replace(LONE_SURROGATE, '�')).replace(
    /[!'()*]/g,
    (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase(),
  );
}

/** Expected UTF-8 sequence length for a lead byte, or 0 if it can't start a sequence. */
function utf8Length(lead: number): number {
  if (lead < 0x80) return 1;
  if (lead >= 0xc2 && lead <= 0xdf) return 2;
  if (lead >= 0xe0 && lead <= 0xef) return 3;
  if (lead >= 0xf0 && lead <= 0xf4) return 4;
  return 0;
}

const strictUtf8 = new TextDecoder('utf-8', { fatal: true });

/** The byte of a well-formed `%XX` at `s[i]`, or -1. */
function escapedByteAt(s: string, i: number): number {
  if (s.charCodeAt(i) !== 0x25 || i + 3 > s.length) return -1;
  const hex = s.slice(i + 1, i + 3);
  return /^[0-9a-fA-F]{2}$/.test(hex) ? parseInt(hex, 16) : -1;
}

/**
 * Lenient inverse of {@link escapeDataString}, like `Uri.UnescapeDataString`: malformed `%`
 * sequences and escaped bytes that are not valid UTF-8 are left exactly as written, never thrown on
 * (unlike `decodeURIComponent`).
 */
export function unescapeDataString(s: string): string {
  let out = '';
  let i = 0;
  while (i < s.length) {
    const lead = escapedByteAt(s, i);
    if (lead < 0) {
      out += s[i];
      i += 1;
      continue;
    }
    const len = utf8Length(lead);
    if (len === 1) {
      out += String.fromCharCode(lead);
      i += 3;
      continue;
    }
    if (len > 1) {
      const bytes = [lead];
      for (let k = 1; k < len; k++) {
        const b = escapedByteAt(s, i + 3 * k);
        if (b < 0) break;
        bytes.push(b);
      }
      if (bytes.length === len) {
        try {
          out += strictUtf8.decode(Uint8Array.from(bytes));
          i += 3 * len;
          continue;
        } catch {
          // fall through: keep the lead byte escaped
        }
      }
    }
    out += s.slice(i, i + 3);
    i += 3;
  }
  return out;
}
