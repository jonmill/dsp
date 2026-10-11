import { readFileSync } from 'node:fs';
import { Deflate, ungzip } from 'pako';
import { describe, expect, test } from 'vitest';
import { decodeBlueprint, decodeBody, encodeBlueprint, encodeBody } from './codec';
import { escapeDataString, unescapeDataString } from './escape';
import { md5f } from './md5f';
import type { Blueprint, BlueprintBody, BlueprintBuilding, BuildingMarker } from './model';
import { BlueprintError } from './model';

const sample = (name: string) =>
  readFileSync(new URL(`../../../test/fixtures/blueprints/${name}`, import.meta.url), 'utf8').trim();

const BAB = 'bab-single-0.10.28.txt';
const MIXED = 'mixed-16-buildings-0.9.24.txt';
const ILS = 'ils-configured-0.9.24.txt';
const CAPSULE = 'capsule-production-v2-reform-0.10.33.txt';
const BELTS_V1 = 'belts-header-v1-marker-102-0.10.34.txt';
const HASH_VALID = [BAB, MIXED, ILS, CAPSULE];

const utf8 = (s: string) => new TextEncoder().encode(s);
const signed = (text: string) => `${text}"${md5f(utf8(text))}`;

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');

function gzipWithOs(raw: Uint8Array, os: number): Uint8Array {
  const d = new Deflate({ level: 6, gzip: true, header: { os } });
  d.push(raw, true);
  return d.result;
}

/** Parts of a sample string: header text (before the first quote) and the raw gunzipped body. */
function split(name: string) {
  const s = sample(name);
  const q1 = s.indexOf('"');
  const q2 = s.lastIndexOf('"');
  const gz = Buffer.from(s.slice(q1 + 1, q2), 'base64');
  return { header: s.slice(0, q1), gz, raw: ungzip(gz), os: gz[9] };
}

/** A hash-valid string made from sample `name` with its raw body replaced by `mutate(raw)`. */
function withBody(name: string, mutate: (raw: Uint8Array) => Uint8Array): string {
  const { header, raw, os } = split(name);
  return signed(`${header}"${b64(gzipWithOs(mutate(raw), os))}`);
}

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(BlueprintError);
    return (e as BlueprintError).code;
  }
  return undefined;
}

/** Assert `fn` throws a BlueprintError with this code and (optionally) a message matching `pattern`. */
function expectFailure(fn: () => unknown, code: string, pattern?: RegExp): void {
  let thrown: unknown;
  try {
    fn();
  } catch (e) {
    thrown = e;
  }
  expect(thrown).toBeInstanceOf(BlueprintError);
  expect((thrown as BlueprintError).code).toBe(code);
  if (pattern) expect((thrown as BlueprintError).message).toMatch(pattern);
}

describe('byte-exact round trip of the hash-valid samples', () => {
  test.each(HASH_VALID)('%s: encode(decode(s)) === s', (name) => {
    const s = sample(name);
    expect(encodeBlueprint(decodeBlueprint(s))).toBe(s);
  });

  test('characters after the 32-char hash are ignored (the game compares only those 32)', () => {
    const s = sample(BAB);
    expect(encodeBlueprint(decodeBlueprint(`${s}XYZ`))).toBe(s);
  });

  test('whitespace around the string is ignored', () => {
    const s = sample(BAB);
    expect(encodeBlueprint(decodeBlueprint(`  ${s}\r\n`))).toBe(s);
  });
});

describe('0.10.34 sample (header v1, marker -102, hash does not validate)', () => {
  const s = sample(BELTS_V1);

  test('the default hash check rejects it', () => {
    expectFailure(() => decodeBlueprint(s), 'HASH', /hash mismatch/);
  });

  test('re-encodes identically except for the 32-char hash, which becomes a valid MD5F', () => {
    const bp = decodeBlueprint(s, { verifyHash: false });
    const out = encodeBlueprint(bp);
    expect(out.slice(0, -32)).toBe(s.slice(0, -32));
    expect(out.slice(-32)).toBe(md5f(utf8(out.slice(0, out.lastIndexOf('"')))));
    expect(out.slice(-32)).not.toBe(s.slice(-32));
    expect(decodeBlueprint(out)).toEqual(bp);
  });

  test('header v1 fields', () => {
    const { header, body, gzipOs } = decodeBlueprint(s, { verifyHash: false });
    expect(header.headerVersion).toBe(1);
    expect(header.layout).toBe(10);
    expect(header.icons).toEqual([0, 0, 0, 0, 0]);
    expect(header.ticks).toBe(639048397218920336n);
    expect(header.gameVersion).toBe('0.10.34.28326');
    expect(header.shortDesc).toBe('Testing Header');
    expect(header.author).toBe('LRFalk01');
    expect(header.customVersion).toBe('1.1');
    expect(header.attributes).toBe(':Attribute 1\\\\bait\\b;');
    expect(header.desc).toBe('Desc');
    expect(header.rawCells).toHaveLength(15);
    expect(gzipOs).toBe(0x0a);
    expect(body.version).toBe(2);
    expect(body.patch2).toBe(1);
    expect(Array.from(body.reformRaw ?? [])).toEqual([0]);
  });

  test('37 belts, all marker -102 with content flag 0', () => {
    const { body } = decodeBlueprint(s, { verifyHash: false });
    expect(body.buildings).toHaveLength(37);
    for (const b of body.buildings) {
      expect(b.marker).toBe(-102);
      expect(b.itemId).toBe(2001);
      expect(b.contentFlag).toBe(0);
      expect(b.content).toBeUndefined();
    }
  });
});

describe('sample structure', () => {
  test('capsule: 331 buildings, all -101, body version 2 with a reform block', () => {
    const { header, body, gzipOs } = decodeBlueprint(sample(CAPSULE));
    expect(header.headerVersion).toBe(0);
    expect(header.gameVersion).toBe('0.10.33.27026');
    expect(header.shortDesc).toBe('Logi P&A Capsule Production');
    expect(header.desc).toContain('\nRequests materials through the distribution network.\n');
    expect(gzipOs).toBe(0x0a);
    expect(body.version).toBe(2);
    expect(body.patch2).toBe(1);
    // hasReform=1, then one 16x27 foundation rect (BF §3.5), no custom colours
    expect(Array.from(body.reformRaw ?? [])).toEqual([
      1, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 16, 27, 32, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    ]);
    expect(body.areas).toEqual([
      { index: 0, parentIndex: -1, tropicAnchor: 0, areaSegments: 200, anchorLocalOffsetX: 0, anchorLocalOffsetY: 0, width: 17, height: 26 },
    ]);
    expect(body.buildings).toHaveLength(331);
    expect(body.buildings.every((b) => b.marker === -101)).toBe(true);

    const count = (id: number) => body.buildings.filter((b) => b.itemId === id).length;
    expect(count(2003)).toBe(247);
    expect(count(2013)).toBe(36);
    expect(count(2020)).toBe(9);
    expect(count(2030)).toBe(1);
    expect(count(2101)).toBe(9);
    expect(count(2107)).toBe(9);
    expect(count(2201)).toBe(4);
    expect(count(2304)).toBe(8);
    expect(count(2313)).toBe(8);

    const splitter = body.buildings.find((b) => b.itemId === 2020);
    expect(splitter?.parameters).toHaveLength(6);
    const monitor = body.buildings.find((b) => b.itemId === 2030);
    expect(monitor?.parameters).toHaveLength(128);
    const depot = body.buildings.find((b) => b.itemId === 2101);
    expect(depot?.parameters).toHaveLength(110);
    expect(body.buildings.find((b) => b.itemId === 2304)?.recipeId).toBe(142);
  });

  test('capsule: sorters carry both end points, belts default pos2 to pos', () => {
    const { body } = decodeBlueprint(sample(CAPSULE));
    const sorter = body.buildings.find((b) => b.itemId === 2013)!;
    expect(sorter.parameters).toHaveLength(1);
    // Field order is not covered by the byte round trip (they are all float32), so check it against
    // physical sense: tilt/pitch near 0 degrees, the second point a few cells from the first, and
    // the 359.7988 (= -0.2 degrees) pitch2 BF §3.3 reports.
    expect(Math.abs(sorter.tilt)).toBeLessThan(0.01);
    expect(Math.abs(sorter.pitch)).toBeLessThan(0.01);
    expect(Math.abs(sorter.localOffset2[0] - sorter.localOffset[0])).toBeLessThan(3);
    expect(Math.abs(sorter.localOffset2[1] - sorter.localOffset[1])).toBeLessThan(3);
    expect(Math.abs(sorter.yaw2 - sorter.yaw)).toBeLessThan(1);
    expect(sorter.pitch2).toBeCloseTo(359.7988, 3);
    const belt = body.buildings.find((b) => b.itemId === 2003);
    expect(belt?.localOffset2).toEqual(belt?.localOffset);
    expect(belt?.yaw2).toBe(belt?.yaw);
    expect(belt?.tilt2).toBe(belt?.tilt);
    expect(belt?.pitch).toBe(0);
    const assembler = body.buildings.find((b) => b.itemId === 2304);
    expect(assembler?.localOffset2).toEqual(assembler?.localOffset);
    expect(assembler?.tilt).toBe(0);
  });

  test('ILS: station params follow the BF §4.1 layout', () => {
    const { header, body } = decodeBlueprint(sample(ILS));
    expect(header.shortDesc).toBe('1');
    expect(header.icons).toEqual([2104, 0, 0, 0, 0]);
    expect(body.version).toBe(1);
    expect(body.buildings).toHaveLength(37);
    expect(body.buildings.every((b) => b.marker === -1)).toBe(true);
    expect(body.buildings.filter((b) => b.itemId === 2002)).toHaveLength(36);

    const ils = body.buildings.find((b) => b.itemId === 2104);
    expect(ils).toBeDefined();
    const p = ils!.parameters;
    expect(p).toBeInstanceOf(Int32Array);
    expect(p).toHaveLength(2048);
    expect(Array.from(p.subarray(0, 4))).toEqual([6001, 1, 1, 10000]);
    expect(p[320]).toBe(1_000_000);
    expect(p[321]).toBe(64278761);
    expect(p[322]).toBe(144000); // 6 ly
  });

  test('mixed: a 160-segment area and legacy records', () => {
    const { header, body } = decodeBlueprint(sample(MIXED));
    expect(header.shortDesc).toBe('test');
    expect(header.desc).toBe('test desc');
    expect(header.ticks).toBe(637818182165693716n);
    expect(body.areas[0].areaSegments).toBe(160);
    expect(body.buildings).toHaveLength(16);
    expect(body.buildings.every((b) => b.marker === -1)).toBe(true);
    expect(body.patch2).toBeUndefined();
    expect(body.reformRaw).toBeUndefined();
    const splitter = body.buildings.find((b) => b.itemId === 2020);
    expect(Array.from(splitter!.parameters)).toEqual([0, 0, 1, 0]);
    const labelled = body.buildings.filter((b) => b.itemId === 2001 && b.parameters.length === 2);
    expect(labelled.map((b) => Array.from(b.parameters))).toEqual([
      [1002, 0],
      [1002, 0],
    ]);
  });

  test('BAB: single legacy building with 110 params', () => {
    const { header, body, gzipOs } = decodeBlueprint(sample(BAB));
    expect(header.layout).toBe(23);
    expect(header.icons.slice(0, 2)).toEqual([3009, 609]);
    expect(header.shortDesc).toBe('BAB (Filtered for Level 9)');
    expect(header.desc).toBe('');
    expect(gzipOs).toBe(0x0b);
    expect(body.buildings).toHaveLength(1);
    expect(body.buildings[0].itemId).toBe(3009);
    expect(body.buildings[0].modelIndex).toBe(453);
    expect(body.buildings[0].parameters).toHaveLength(110);
    expect(body.buildings[0].parameters[1]).toBe(9);
  });

  test('decoded links stay consistent: every link is -1 or an in-range index', () => {
    for (const name of HASH_VALID) {
      const { body } = decodeBlueprint(sample(name));
      body.buildings.forEach((b, i) => {
        expect(b.index).toBe(i);
        for (const link of [b.outputObjIdx, b.inputObjIdx]) {
          expect(link >= -1 && link < body.buildings.length, name).toBe(true);
        }
      });
    }
  });
});

describe('header editing', () => {
  test('an edited field is re-escaped; untouched cells keep their raw text', () => {
    const s = sample(CAPSULE);
    const bp = decodeBlueprint(s);
    bp.header.shortDesc = 'New name, with: stuff!';
    const out = encodeBlueprint(bp);
    const cells = out.slice(10, out.indexOf('"')).split(',');
    const orig = s.slice(10, s.indexOf('"')).split(',');
    expect(cells[10]).toBe('New%20name%2C%20with%3A%20stuff%21');
    for (const i of [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]) expect(cells[i]).toBe(orig[i]);
    expect(cells[11]).toBe(orig[11]);
    expect(decodeBlueprint(out).header.shortDesc).toBe('New name, with: stuff!');
  });

  test('a cell whose decoded value is unchanged keeps its non-canonical raw escaping', () => {
    const s = sample(MIXED).replace('test%20desc', 'test%20de%73c'); // %73 = "s", non-canonical
    const bp = decodeBlueprint(s, { verifyHash: false });
    expect(bp.header.desc).toBe('test desc');
    const out = encodeBlueprint(bp);
    expect(out.slice(0, out.indexOf('"'))).toBe(s.slice(0, s.indexOf('"')));
  });

  test('a Blueprint built from scratch (no rawCells) round-trips through the string', () => {
    const body: BlueprintBody = {
      version: 2,
      cursorOffsetX: 0,
      cursorOffsetY: 0,
      cursorTargetArea: 0,
      dragBoxSizeX: 1,
      dragBoxSizeY: 1,
      primaryAreaIdx: 0,
      areas: [
        {
          index: 0,
          parentIndex: -1,
          tropicAnchor: 0,
          areaSegments: 200,
          anchorLocalOffsetX: 0,
          anchorLocalOffsetY: 0,
          width: 4,
          height: 4,
        },
      ],
      buildings: [building({ marker: -101, itemId: 2303, modelIndex: 65, parameters: new Int32Array([0]) })],
    };
    const bp: Blueprint = {
      header: {
        rawCells: [],
        headerVersion: 0,
        layout: 10,
        icons: [2303, 0, 0, 0, 0],
        ticks: 638000000000000000n,
        gameVersion: '0.10.33.27026',
        shortDesc: 'Planner, "test"',
        desc: '100% line\nsecond',
      },
      body,
      gzipOs: 0x0a,
    };
    const out = encodeBlueprint(bp);
    expect(out.startsWith('BLUEPRINT:0,10,2303,0,0,0,0,0,638000000000000000,0.10.33.27026,Planner%2C%20%22test%22,')).toBe(true);
    const back = decodeBlueprint(out);
    expect(back.header.shortDesc).toBe('Planner, "test"');
    expect(back.header.desc).toBe('100% line\nsecond');
    expect(back.header.rawCells).toHaveLength(12);
    expect(back.body).toEqual({ ...body, patch2: 1, reformRaw: Uint8Array.of(0) });
    expect(encodeBlueprint(back)).toBe(out);
  });

  test('a from-scratch header v1 writes the 15 cells', () => {
    const bp = decodeBlueprint(sample(BELTS_V1), { verifyHash: false });
    bp.header.rawCells = [];
    bp.header.author = 'me';
    bp.header.customVersion = '2';
    bp.header.attributes = 'a;b';
    const out = encodeBlueprint(bp);
    const cells = out.slice(10, out.indexOf('"')).split(',');
    expect(cells).toHaveLength(15);
    expect(cells.slice(11)).toEqual(['me', '2', 'a%3Bb', 'Desc']);
    expect(decodeBlueprint(out).header.attributes).toBe('a;b');
  });
});

describe('decode errors', () => {
  test('NOT_BLUEPRINT', () => {
    expect(codeOf(() => decodeBlueprint(''))).toBe('NOT_BLUEPRINT');
    expect(codeOf(() => decodeBlueprint('hello world'))).toBe('NOT_BLUEPRINT');
    expect(codeOf(() => decodeBlueprint('DYBP:0,1,2"abc"' + '0'.repeat(32)))).toBe('NOT_BLUEPRINT');
  });

  test('HASH: one changed base64 character', () => {
    const s = sample(CAPSULE);
    const i = s.indexOf('"') + 50;
    const swapped = s[i] === 'A' ? 'B' : 'A';
    const tampered = s.slice(0, i) + swapped + s.slice(i + 1);
    expect(codeOf(() => decodeBlueprint(tampered))).toBe('HASH');
  });

  test('HASH: changed header text, missing or lowercase hash', () => {
    const s = sample(MIXED);
    expect(codeOf(() => decodeBlueprint(s.replace('test%20desc', 'test%20DESC')))).toBe('HASH');
    expect(codeOf(() => decodeBlueprint(s.slice(0, -32)))).toBe('HASH');
    expect(codeOf(() => decodeBlueprint(s.slice(0, -32) + s.slice(-32).toLowerCase()))).toBe('HASH');
  });

  test('HEADER: no quote, or too few cells', () => {
    expect(codeOf(() => decodeBlueprint('BLUEPRINT:0,10,0,0,0,0,0,0,1,0.9.24.11286,x,y'))).toBe('HEADER');
    expect(codeOf(() => decodeBlueprint(signed('BLUEPRINT:0,10,0,0,0,0,0,0,1,0.9.24.11286,x"AAAA')))).toBe('HEADER');
    // v1 needs 15 cells
    expect(
      codeOf(() => decodeBlueprint(signed('BLUEPRINT:1,10,0,0,0,0,0,0,1,0.10.34.28326,a,b,c,d"AAAA'))),
    ).toBe('HEADER');
    // unknown header version
    expect(
      codeOf(() => decodeBlueprint(signed('BLUEPRINT:7,10,0,0,0,0,0,0,1,0.10.34.28326,a,b,c,d,e,f,g"AAAA'))),
    ).toBe('HEADER');
  });

  test('BASE64: invalid characters, bad length, missing payload quote', () => {
    const head = 'BLUEPRINT:0,10,0,0,0,0,0,0,1,0.9.24.11286,x,y';
    expect(codeOf(() => decodeBlueprint(signed(`${head}"@@@@`)))).toBe('BASE64');
    expect(codeOf(() => decodeBlueprint(signed(`${head}"AAA`)))).toBe('BASE64');
    expect(codeOf(() => decodeBlueprint(signed(`${head}"AA=A`)))).toBe('BASE64');
    expect(codeOf(() => decodeBlueprint(`${head}${'0'.repeat(32)}`, { verifyHash: false }))).toBe('HEADER');
    expect(codeOf(() => decodeBlueprint(`${head}"${'A'.repeat(8)}`, { verifyHash: false }))).toBe('BASE64');
  });

  test('GZIP: valid base64 that is not a gzip stream', () => {
    const head = 'BLUEPRINT:0,10,0,0,0,0,0,0,1,0.9.24.11286,x,y';
    expect(codeOf(() => decodeBlueprint(signed(`${head}"${b64(utf8('not gzip data at all'))}`)))).toBe('GZIP');
    expect(codeOf(() => decodeBlueprint(signed(`${head}"`)))).toBe('GZIP');
    const { gz } = split(MIXED);
    const cut = gz.subarray(0, gz.length - 20);
    expect(codeOf(() => decodeBlueprint(signed(`${head}"${b64(cut)}`)))).toBe('GZIP');
  });

  test('BODY: truncated at any point', () => {
    const { raw } = split(CAPSULE);
    for (const keep of [0, 3, 20, 29, 40, 47, 60, 1000, raw.length - 10, raw.length - 1]) {
      const s = withBody(CAPSULE, (r) => r.slice(0, keep));
      expectFailure(() => decodeBlueprint(s), 'BODY', /unexpected end of data|run past the end/);
    }
  });

  test('BODY: trailing bytes after the body', () => {
    for (const name of [MIXED, CAPSULE]) {
      const s = withBody(name, (r) => Uint8Array.from([...r, 0]));
      expectFailure(() => decodeBlueprint(s), 'BODY', /1 unread byte/);
    }
  });

  test('BODY: area count over 64, building count over 1048576 or negative', () => {
    const areaCountAt = 28;
    const tooManyAreas = withBody(MIXED, (r) => {
      const c = r.slice();
      c[areaCountAt] = 65;
      return c;
    });
    expectFailure(() => decodeBlueprint(tooManyAreas), 'BODY', /area count 65/);

    const countAt = areaCountAt + 1 + 14 * split(MIXED).raw[areaCountAt];
    for (const n of [1048577, -1]) {
      const s = withBody(MIXED, (r) => {
        const c = r.slice();
        new DataView(c.buffer).setInt32(countAt, n, true);
        return c;
      });
      expectFailure(() => decodeBlueprint(s), 'BODY', new RegExp(`building count ${n}`));
    }
  });

  test('BODY: a building whose index is not its position', () => {
    const { raw } = split(CAPSULE);
    const first = 28 + 1 + 14 * raw[28] + 4;
    const s = withBody(CAPSULE, (r) => {
      const c = r.slice();
      new DataView(c.buffer).setInt32(first + 4, 7, true); // marker at +0, index at +4
      return c;
    });
    expectFailure(() => decodeBlueprint(s), 'BODY', /position 0 has index 7/);
  });

  test('BODY: an out-of-range or below -1 link', () => {
    const { raw } = split(MIXED);
    const first = 28 + 1 + 14 * raw[28] + 4;
    const view = new DataView(raw.buffer, raw.byteOffset);
    // legacy record: index 4, area 1, offsets 12+12, yaw 4+4, itemId 2, model 2 => outputObjIdx at +41
    expect(view.getInt32(first, true)).toBe(0);
    const outputObjIdxAt = first + 41;
    for (const v of [16, 99, -2]) {
      const s = withBody(MIXED, (r) => {
        const c = r.slice();
        new DataView(c.buffer).setInt32(outputObjIdxAt, v, true);
        return c;
      });
      expectFailure(() => decodeBlueprint(s), 'BODY', new RegExp(`outputObjIdx ${v} is out of range`));
    }
    const inputObjIdxAt = outputObjIdxAt + 4;
    const s = withBody(MIXED, (r) => {
      const c = r.slice();
      new DataView(c.buffer).setInt32(inputObjIdxAt, 16, true);
      return c;
    });
    expectFailure(() => decodeBlueprint(s), 'BODY', /inputObjIdx 16 is out of range/);
  });

  test('BODY: unknown building marker, negative param count', () => {
    const { raw } = split(CAPSULE);
    const first = 28 + 1 + 14 * raw[28] + 4;
    const s = withBody(CAPSULE, (r) => {
      const c = r.slice();
      new DataView(c.buffer).setInt32(first, -103, true);
      return c;
    });
    expectFailure(() => decodeBlueprint(s), 'BODY', /unknown building record marker -103/);

    // -101 record: 49 bytes with the 2-byte paramCount last, +4 for a belt's tilt, +32 for a sorter's extras
    const { itemId } = decodeBlueprint(sample(CAPSULE)).body.buildings[0];
    const extra = itemId > 2000 && itemId < 2010 ? 4 : itemId > 2010 && itemId < 2020 ? 32 : 0;
    const paramCountAt = first + 47 + extra;
    const neg = withBody(CAPSULE, (r) => {
      const c = r.slice();
      new DataView(c.buffer).setInt16(paramCountAt, -1, true);
      return c;
    });
    expectFailure(() => decodeBlueprint(neg), 'BODY', /negative parameter count -1/);
  });
});

/** A building with all-default fields, overridable. */
function building(over: Partial<BlueprintBuilding> = {}): BlueprintBuilding {
  return {
    marker: -101,
    index: 0,
    areaIndex: 0,
    localOffset: [1.5, 2.5, 0],
    localOffset2: [1.5, 2.5, 0],
    yaw: 90,
    yaw2: 90,
    tilt: 0,
    pitch: 0,
    tilt2: 0,
    pitch2: 0,
    itemId: 2303,
    modelIndex: 65,
    outputObjIdx: -1,
    inputObjIdx: -1,
    outputToSlot: 0,
    inputFromSlot: 0,
    outputFromSlot: 0,
    inputToSlot: 0,
    outputOffset: 0,
    inputOffset: 0,
    recipeId: 0,
    filterId: 0,
    parameters: new Int32Array(0),
    ...over,
  };
}

function bodyOf(buildings: BlueprintBuilding[], over: Partial<BlueprintBody> = {}): BlueprintBody {
  return {
    version: 1,
    cursorOffsetX: 3,
    cursorOffsetY: -4,
    cursorTargetArea: 0,
    dragBoxSizeX: 5,
    dragBoxSizeY: 6,
    primaryAreaIdx: 0,
    areas: [],
    buildings,
    ...over,
  };
}

describe('encodeBody / decodeBody', () => {
  const f = Math.fround;

  /** Prefix size with no areas: version + 6 int32 + areaCount + buildingCount. */
  const PREFIX = 4 + 24 + 1 + 4;

  test('legacy record is 61 bytes + 4 per param; tilt/pitch are not stored', () => {
    const b = building({
      marker: -1,
      localOffset2: [1.5, 2.5, 0],
      parameters: new Int32Array([1, 2, 3]),
    });
    const bytes = encodeBody(bodyOf([b]));
    expect(bytes.length).toBe(PREFIX + 61 + 12);
    expect(decodeBody(bytes).buildings[0]).toEqual(b);
  });

  test('legacy keeps both end points and yaws', () => {
    const b = building({ marker: -1, localOffset2: [4, 5, 6], yaw2: 270 });
    const back = decodeBody(encodeBody(bodyOf([b]))).buildings[0];
    expect(back.localOffset2).toEqual([4, 5, 6]);
    expect(back.yaw2).toBe(270);
  });

  test('-100 record is 69 bytes and stores tilt only', () => {
    const b = building({ marker: -100, tilt: f(12.5), localOffset2: [7, 8, 9], yaw2: 10, tilt2: 0 });
    const bytes = encodeBody(bodyOf([b]));
    expect(bytes.length).toBe(PREFIX + 69);
    expect(decodeBody(bytes).buildings[0]).toEqual(b);
  });

  test('-101: plain building 49 bytes, belt 53, sorter 81', () => {
    const plain = building({ marker: -101, itemId: 2303 });
    expect(encodeBody(bodyOf([plain])).length).toBe(PREFIX + 49);

    const belt = building({ marker: -101, itemId: 2003, tilt: f(1.25), tilt2: f(1.25) });
    const beltBytes = encodeBody(bodyOf([belt]));
    expect(beltBytes.length).toBe(PREFIX + 53);
    expect(decodeBody(beltBytes).buildings[0]).toEqual(belt);

    const sorter = building({
      marker: -101,
      itemId: 2013,
      localOffset: [1, 2, 3],
      localOffset2: [4, 5, 6],
      yaw: 10,
      yaw2: 20,
      tilt: f(359.7988),
      pitch: f(1.5),
      tilt2: f(2.5),
      pitch2: f(3.5),
      parameters: new Int32Array([2]),
    });
    const sorterBytes = encodeBody(bodyOf([sorter]));
    expect(sorterBytes.length).toBe(PREFIX + 81 + 4);
    expect(decodeBody(sorterBytes).buildings[0]).toEqual(sorter);
  });

  test('belt and sorter id ranges are exclusive: 2010 and 2020 are neither', () => {
    for (const [id, extra] of [
      [2000, 0],
      [2001, 4],
      [2009, 4],
      [2010, 0],
      [2011, 32],
      [2019, 32],
      [2020, 0],
    ] as const) {
      const bytes = encodeBody(bodyOf([building({ marker: -101, itemId: id })]));
      expect(bytes.length, `item ${id}`).toBe(PREFIX + 49 + extra);
    }
  });

  test('-102 stores a content flag and, when positive, 7-bit-length-prefixed UTF-8', () => {
    const none = building({ marker: -102, contentFlag: 0 });
    expect(encodeBody(bodyOf([none])).length).toBe(PREFIX + 49 + 4);
    expect(decodeBody(encodeBody(bodyOf([none]))).buildings[0]).toEqual(none);

    const text = '处理器 ' + 'x'.repeat(60); // 3*3 + 1 + 60 = 70 bytes < 128
    const withText = building({ marker: -102, itemId: 2401, contentFlag: 9, content: text });
    const bytes = encodeBody(bodyOf([withText]));
    expect(bytes.length).toBe(PREFIX + 49 + 4 + 1 + 70);
    expect(decodeBody(bytes).buildings[0]).toEqual(withText);

    // two-byte length prefix at 128+ bytes
    const long = building({ marker: -102, contentFlag: 3, content: 'y'.repeat(300) });
    const longBytes = encodeBody(bodyOf([long]));
    expect(longBytes.length).toBe(PREFIX + 49 + 4 + 2 + 300);
    expect(longBytes[PREFIX + 49 + 4]).toBe(0xac); // 300 = 0b10_0101100 -> 0xAC 0x02
    expect(longBytes[PREFIX + 49 + 4 + 1]).toBe(0x02);
    expect(decodeBody(longBytes).buildings[0].content).toBe('y'.repeat(300));
  });

  test('-102: a raw content flag is preserved, and defaults to content length when absent', () => {
    const raw = building({ marker: -102, contentFlag: 12345, content: 'hi' });
    expect(decodeBody(encodeBody(bodyOf([raw]))).buildings[0].contentFlag).toBe(12345);

    const derived = building({ marker: -102, content: 'hi' });
    const back = decodeBody(encodeBody(bodyOf([derived]))).buildings[0];
    expect(back.content).toBe('hi');
    expect(back.contentFlag).toBeGreaterThan(0);

    const noContent = building({ marker: -102 });
    const none = decodeBody(encodeBody(bodyOf([noContent]))).buildings[0];
    expect(none.contentFlag).toBe(0);
    expect(none.content).toBeUndefined();
  });

  test('float32 values survive exactly; a wider double is rounded to float32', () => {
    const odd = [f(4.9417), f(1.8516), f(0.0017), f(-0), f(359.7988), f(1e-30), f(3.4e38)] as const;
    const b = building({ marker: -101, itemId: 2003, localOffset: [odd[0], odd[1], odd[2]], yaw: odd[4], tilt: odd[5], tilt2: odd[5] });
    const back = decodeBody(encodeBody(bodyOf([b]))).buildings[0];
    expect(back.localOffset).toEqual([odd[0], odd[1], odd[2]]);
    expect(back.yaw).toBe(odd[4]);
    expect(back.tilt).toBe(odd[5]);

    const negZero = decodeBody(encodeBody(bodyOf([building({ localOffset: [-0, 0, 0] })]))).buildings[0];
    expect(Object.is(negZero.localOffset[0], -0)).toBe(true);

    const wide = decodeBody(encodeBody(bodyOf([building({ localOffset: [0.1, 0, 0] })]))).buildings[0];
    expect(wide.localOffset[0]).toBe(f(0.1));
  });

  test('parameters keep their exact length and values', () => {
    for (const n of [0, 1, 2, 6, 110, 128, 2048]) {
      const p = Int32Array.from({ length: n }, (_, i) => (i % 2 ? -i : i * 1000003));
      const back = decodeBody(encodeBody(bodyOf([building({ parameters: p })]))).buildings[0];
      expect(back.parameters).toBeInstanceOf(Int32Array);
      expect(Array.from(back.parameters)).toEqual(Array.from(p));
    }
  });

  test('the version-2 trailer: patch2 and the raw reform block are carried', () => {
    const reform = Uint8Array.from([
      1, 0, 1, 0, 0, 0, 0, 5, 0, 6, 0, 16, 27, 0x20, 0, 0, 0, 0, 0, 2, 0, 0, 0, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88,
    ]);
    const body = bodyOf([building()], { version: 2, patch2: 9, reformRaw: reform });
    const back = decodeBody(encodeBody(body));
    expect(back.version).toBe(2);
    expect(back.patch2).toBe(9);
    expect(back.reformRaw).toEqual(reform);
    expect(encodeBody(back)).toEqual(encodeBody(body));
  });

  test('version 2 defaults to patch2 = 1 and hasReform = 0', () => {
    const bytes = encodeBody(bodyOf([], { version: 2 }));
    expect(Array.from(bytes.slice(-5))).toEqual([1, 0, 0, 0, 0]);
    const back = decodeBody(bytes);
    expect(back.patch2).toBe(1);
    expect(Array.from(back.reformRaw ?? [])).toEqual([0]);
  });

  test('version 1 has no trailer and ignores patch2/reformRaw', () => {
    const bytes = encodeBody(bodyOf([], { version: 1, patch2: 5, reformRaw: Uint8Array.of(1) }));
    expect(bytes.length).toBe(PREFIX);
    const back = decodeBody(bytes);
    expect(back.patch2).toBeUndefined();
    expect(back.reformRaw).toBeUndefined();
  });

  test('areas round-trip, including negative and int16 extremes', () => {
    const area = {
      index: 1,
      parentIndex: -1,
      tropicAnchor: -300,
      areaSegments: 32767,
      anchorLocalOffsetX: -32768,
      anchorLocalOffsetY: 12,
      width: 100,
      height: 200,
    };
    const body = bodyOf([], { areas: [area, { ...area, index: 2, parentIndex: 1 }] });
    expect(decodeBody(encodeBody(body)).areas).toEqual(body.areas);
    expect(encodeBody(body).length).toBe(PREFIX + 28);
  });

  test('linked buildings keep their link and slot fields', () => {
    const a = building({ index: 0, outputObjIdx: 1, outputToSlot: 3, inputFromSlot: -1, outputFromSlot: 14, inputToSlot: 15, outputOffset: -2, inputOffset: 127 });
    const b = building({ index: 1, inputObjIdx: 0, recipeId: 142, filterId: 1607, modelIndex: -5, areaIndex: 2 });
    const back = decodeBody(encodeBody(bodyOf([a, b]))).buildings;
    expect(back).toEqual([a, b]);
  });

  test('writing a value that does not fit its field throws BODY instead of wrapping', () => {
    const cases: Partial<BlueprintBuilding>[] = [
      { itemId: 40000 },
      { modelIndex: 1.5 },
      { areaIndex: 200 },
      { outputToSlot: 128 },
      { recipeId: Number.NaN },
      { outputObjIdx: 2 ** 31 },
    ];
    for (const over of cases) {
      expect(codeOf(() => encodeBody(bodyOf([building(over)]))), JSON.stringify(over)).toBe('BODY');
    }
    expect(codeOf(() => encodeBody(bodyOf([building({ index: 3 })])))).toBe('BODY');
    expect(codeOf(() => encodeBody(bodyOf([building({ outputObjIdx: 1 })])))).toBe('BODY');
    expect(codeOf(() => encodeBody(bodyOf([building({ marker: -103 as BuildingMarker })])))).toBe('BODY');
    expect(codeOf(() => encodeBody(bodyOf([], { areas: Array.from({ length: 65 }, (_, index) => ({ index, parentIndex: -1, tropicAnchor: 0, areaSegments: 200, anchorLocalOffsetX: 0, anchorLocalOffsetY: 0, width: 1, height: 1 })) })))).toBe('BODY');
  });
});

describe('escape helpers stay in step with the samples', () => {
  test('every header text cell of every sample is a fixed point of unescape then escape', () => {
    for (const name of [...HASH_VALID, BELTS_V1]) {
      const s = sample(name);
      const cells = s.slice(10, s.indexOf('"')).split(',');
      for (const c of cells.slice(10)) expect(escapeDataString(unescapeDataString(c)), `${name}: ${c}`).toBe(c);
    }
  });
});
