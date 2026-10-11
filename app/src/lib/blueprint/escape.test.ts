import { describe, expect, test } from 'vitest';
import { escapeDataString, unescapeDataString } from './escape';

describe('escapeDataString (Uri.EscapeDataString, BF §1.3)', () => {
  test('escapes the characters encodeURIComponent leaves alone', () => {
    expect(escapeDataString("a b!()*'")).toBe('a%20b%21%28%29%2A%27');
  });

  test('keeps only RFC 3986 unreserved characters', () => {
    expect(escapeDataString('AZaz09-_.~')).toBe('AZaz09-_.~');
    expect(escapeDataString(',&\n"%')).toBe('%2C%26%0A%22%25');
  });

  test('non-ASCII text becomes uppercase-hex UTF-8', () => {
    expect(escapeDataString('处理器')).toBe('%E5%A4%84%E7%90%86%E5%99%A8');
    expect(escapeDataString('é')).toBe('%C3%A9');
    expect(escapeDataString('😀')).toBe('%F0%9F%98%80');
  });

  test('a lone surrogate becomes U+FFFD instead of throwing', () => {
    expect(escapeDataString('a\ud800b')).toBe('a%EF%BF%BDb');
  });
});

describe('unescapeDataString (Uri.UnescapeDataString, tolerant)', () => {
  test('decodes escaped ASCII and UTF-8', () => {
    expect(unescapeDataString('a%20b%21%28%29%2A%27')).toBe("a b!()*'");
    expect(unescapeDataString('%E5%A4%84%E7%90%86%E5%99%A8')).toBe('处理器');
    expect(unescapeDataString('%e5%a4%84')).toBe('处');
  });

  test('leaves malformed % sequences as they are and does not throw', () => {
    expect(unescapeDataString('100%')).toBe('100%');
    expect(unescapeDataString('%')).toBe('%');
    expect(unescapeDataString('%2')).toBe('%2');
    expect(unescapeDataString('%zz')).toBe('%zz');
    expect(unescapeDataString('50%%20off')).toBe('50% off');
  });

  test('leaves invalid UTF-8 escape sequences escaped', () => {
    expect(unescapeDataString('%FF')).toBe('%FF');
    expect(unescapeDataString('%E5%A4')).toBe('%E5%A4');
    expect(unescapeDataString('x%C3y')).toBe('x%C3y');
  });

  test('round-trips escapeDataString', () => {
    for (const s of ['', 'plain', "a b!()*'", '处理器 100%', 'line\nbreak, "quoted" & more', '😀']) {
      expect(unescapeDataString(escapeDataString(s))).toBe(s);
    }
  });
});
