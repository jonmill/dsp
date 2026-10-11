import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { md5f } from './md5f';

const utf8 = (s: string) => new TextEncoder().encode(s);
const sample = (name: string) =>
  readFileSync(new URL(`../../../test/fixtures/blueprints/${name}`, import.meta.url), 'utf8').trim();

/** The text the game hashes: everything before the last quote. */
const hashedText = (str: string) => str.slice(0, str.lastIndexOf('"'));

describe('md5f (BF §2.3 vectors)', () => {
  test.each([
    ['', '84D1CE3BD68F49AB26EB0F96416617CF'],
    ['a', 'F10BDDAECB62E5A92433757867EE06DB'],
    ['abcd', 'FA27C78B6EC31559F0E760CE3F2B03F6'],
    ['Why are you doing this, Youthcat Studio?', '13424E12890A3F50A1F8567C464FFF8C'],
    ['x'.repeat(56), '8BB5C3FC1CB5BFD1EF91C6FB26DA3C44'],
    ['x'.repeat(64), 'F0ADCCB26B1EEDB00EF3F8C5B002EAB5'],
  ])('md5f(%j) = %s', (input, expected) => {
    expect(md5f(utf8(input))).toBe(expected);
  });

  test('bab-single-0.10.28 sample (real game export)', () => {
    expect(md5f(utf8(hashedText(sample('bab-single-0.10.28.txt'))))).toBe('09DCE7720CA8695F93D0C611DD833255');
  });

  test('mixed-16-buildings-0.9.24 sample (real game export)', () => {
    expect(md5f(utf8(hashedText(sample('mixed-16-buildings-0.9.24.txt'))))).toBe('A7DF4C8BFFFC74EA6F1C5C2F8CA778BB');
  });

  test('the stored hash of every hash-valid sample matches', () => {
    for (const name of [
      'bab-single-0.10.28.txt',
      'mixed-16-buildings-0.9.24.txt',
      'ils-configured-0.9.24.txt',
      'capsule-production-v2-reform-0.10.33.txt',
    ]) {
      const s = sample(name);
      const q = s.lastIndexOf('"');
      expect(md5f(utf8(s.slice(0, q))), name).toBe(s.slice(q + 1));
    }
  });
});
