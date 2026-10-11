import { Deflate, ungzip } from 'pako';
import { ByteReader, ByteWriter } from './binary';
import { escapeDataString, unescapeDataString } from './escape';
import { md5f } from './md5f';
import { BlueprintError } from './model';
import type {
  Blueprint,
  BlueprintArea,
  BlueprintBody,
  BlueprintBuilding,
  BlueprintHeader,
  BuildingMarker,
} from './model';

export { BlueprintError } from './model';
export type { BlueprintErrorCode } from './model';

const PREFIX = 'BLUEPRINT:';
const HASH_LENGTH = 32;
const MAX_AREAS = 64;
const MAX_BUILDINGS = 1048576;
const MAX_REFORM_RECTS = 2930400;

const isBelt = (itemId: number) => itemId > 2000 && itemId < 2010;
const isSorter = (itemId: number) => itemId > 2010 && itemId < 2020;

// ---------------------------------------------------------------------------------------------
// Header (BF §1.1)

const INT_CELL = /^[+-]?\d+$/;
const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;

/** `int.TryParse` semantics: a bad number is 0, never an error. */
function parseIntCell(cell: string): number {
  if (!INT_CELL.test(cell)) return 0;
  const n = Number(cell);
  return Number.isSafeInteger(n) && n >= -0x80000000 && n <= 0x7fffffff ? n : 0;
}

/** `long.TryParse` semantics. */
function parseTicksCell(cell: string): bigint {
  if (!INT_CELL.test(cell)) return 0n;
  const n = BigInt(cell);
  return n >= INT64_MIN && n <= INT64_MAX ? n : 0n;
}

function parseHeader(cells: string[]): BlueprintHeader {
  if (cells.length < 12) {
    throw new BlueprintError('HEADER', `header has ${cells.length} cells, expected at least 12`);
  }
  const headerVersion = parseIntCell(cells[0]);
  if (headerVersion !== 0 && headerVersion !== 1) {
    throw new BlueprintError('HEADER', `unsupported header version ${JSON.stringify(cells[0])}`);
  }
  if (headerVersion === 1 && cells.length < 15) {
    throw new BlueprintError('HEADER', `header v1 has ${cells.length} cells, expected at least 15`);
  }
  const header: BlueprintHeader = {
    rawCells: cells.slice(),
    headerVersion,
    layout: parseIntCell(cells[1]),
    icons: [
      parseIntCell(cells[2]),
      parseIntCell(cells[3]),
      parseIntCell(cells[4]),
      parseIntCell(cells[5]),
      parseIntCell(cells[6]),
    ],
    ticks: parseTicksCell(cells[8]),
    gameVersion: cells[9],
    shortDesc: unescapeDataString(cells[10]),
    desc: '',
  };
  if (headerVersion === 1) {
    header.author = unescapeDataString(cells[11]);
    header.customVersion = unescapeDataString(cells[12]);
    header.attributes = unescapeDataString(cells[13]);
    header.desc = unescapeDataString(cells[14]);
  } else {
    header.desc = unescapeDataString(cells[11]);
  }
  return header;
}

/**
 * The header cells to write. A raw cell is re-emitted whenever the field it feeds still decodes to
 * the same value; only changed (or never-read) fields are formatted afresh.
 */
function headerCells(h: BlueprintHeader): string[] {
  const raw = h.rawCells;
  if (h.headerVersion !== 0 && h.headerVersion !== 1) {
    throw new BlueprintError('HEADER', `unsupported header version ${h.headerVersion}`);
  }
  if (/[,"]/.test(h.gameVersion)) {
    throw new BlueprintError('HEADER', `gameVersion ${JSON.stringify(h.gameVersion)} contains a comma or quote`);
  }
  const intCell = (i: number, value: number) => {
    if (!Number.isInteger(value) || value < -0x80000000 || value > 0x7fffffff) {
      throw new BlueprintError('HEADER', `header cell ${i}: ${value} is not an int32`);
    }
    return i < raw.length && parseIntCell(raw[i]) === value ? raw[i] : String(value);
  };
  const textCell = (i: number, value: string | undefined) => {
    const v = value ?? '';
    return i < raw.length && unescapeDataString(raw[i]) === v ? raw[i] : escapeDataString(v);
  };
  if (h.ticks < INT64_MIN || h.ticks > INT64_MAX) {
    throw new BlueprintError('HEADER', `ticks ${h.ticks} is not an int64`);
  }

  const cells = [
    intCell(0, h.headerVersion),
    intCell(1, h.layout),
    ...h.icons.map((icon, k) => intCell(2 + k, icon)),
    raw.length > 7 ? raw[7] : '0',
    raw.length > 8 && parseTicksCell(raw[8]) === h.ticks ? raw[8] : h.ticks.toString(),
    raw.length > 9 && raw[9] === h.gameVersion ? raw[9] : h.gameVersion,
    textCell(10, h.shortDesc),
  ];
  if (h.headerVersion === 1) {
    cells.push(textCell(11, h.author), textCell(12, h.customVersion), textCell(13, h.attributes), textCell(14, h.desc));
  } else {
    cells.push(textCell(11, h.desc));
  }
  // Cells this codec does not know (a newer game appending fields) travel with the same header version.
  if (raw.length > cells.length && parseIntCell(raw[0]) === h.headerVersion) {
    cells.push(...raw.slice(cells.length));
  }
  return cells;
}

// ---------------------------------------------------------------------------------------------
// Body (BF §3)

type Vec3 = [number, number, number];

function readVec3(r: ByteReader): Vec3 {
  return [r.f32(), r.f32(), r.f32()];
}

function writeVec3(w: ByteWriter, v: Vec3): void {
  w.f32(v[0]);
  w.f32(v[1]);
  w.f32(v[2]);
}

function readArea(r: ByteReader): BlueprintArea {
  return {
    index: r.i8(),
    parentIndex: r.i8(),
    tropicAnchor: r.i16(),
    areaSegments: r.i16(),
    anchorLocalOffsetX: r.i16(),
    anchorLocalOffsetY: r.i16(),
    width: r.i16(),
    height: r.i16(),
  };
}

function writeArea(w: ByteWriter, a: BlueprintArea): void {
  w.i8(a.index);
  w.i8(a.parentIndex);
  w.i16(a.tropicAnchor);
  w.i16(a.areaSegments);
  w.i16(a.anchorLocalOffsetX);
  w.i16(a.anchorLocalOffsetY);
  w.i16(a.width);
  w.i16(a.height);
}

function readBuilding(r: ByteReader): BlueprintBuilding {
  const first = r.i32();
  let marker: BuildingMarker;
  if (first >= 0) marker = -1;
  else if (first === -100 || first === -101 || first === -102) marker = first;
  else throw new BlueprintError('BODY', `unknown building record marker ${first} at offset ${r.pos - 4}`);

  let index: number;
  let areaIndex: number;
  let localOffset: Vec3;
  let localOffset2: Vec3;
  let yaw: number;
  let yaw2: number;
  let tilt = 0;
  let pitch = 0;
  let tilt2 = 0;
  let pitch2 = 0;
  let itemId: number;
  let modelIndex: number;

  if (marker === -1 || marker === -100) {
    index = marker === -1 ? first : r.i32();
    areaIndex = r.i8();
    localOffset = readVec3(r);
    localOffset2 = readVec3(r);
    yaw = r.f32();
    yaw2 = r.f32();
    if (marker === -100) tilt = r.f32();
    itemId = r.i16();
    modelIndex = r.i16();
  } else {
    index = r.i32();
    itemId = r.i16();
    modelIndex = r.i16();
    areaIndex = r.i8();
    localOffset = readVec3(r);
    yaw = r.f32();
    if (isSorter(itemId)) {
      tilt = r.f32();
      pitch = r.f32();
      localOffset2 = readVec3(r);
      yaw2 = r.f32();
      tilt2 = r.f32();
      pitch2 = r.f32();
    } else {
      localOffset2 = [...localOffset];
      yaw2 = yaw;
      if (isBelt(itemId)) {
        tilt = r.f32();
        tilt2 = tilt;
      }
    }
  }

  const outputObjIdx = r.i32();
  const inputObjIdx = r.i32();
  const outputToSlot = r.i8();
  const inputFromSlot = r.i8();
  const outputFromSlot = r.i8();
  const inputToSlot = r.i8();
  const outputOffset = r.i8();
  const inputOffset = r.i8();
  const recipeId = r.i16();
  const filterId = r.i16();
  const paramCount = r.i16();
  if (paramCount < 0) {
    throw new BlueprintError('BODY', `building ${index}: negative parameter count ${paramCount}`);
  }
  if (paramCount * 4 > r.remaining) {
    throw new BlueprintError('BODY', `building ${index}: ${paramCount} parameters run past the end of the data`);
  }
  const parameters = new Int32Array(paramCount);
  for (let i = 0; i < paramCount; i++) parameters[i] = r.i32();

  const b: BlueprintBuilding = {
    marker,
    index,
    areaIndex,
    localOffset,
    localOffset2,
    yaw,
    yaw2,
    tilt,
    pitch,
    tilt2,
    pitch2,
    itemId,
    modelIndex,
    outputObjIdx,
    inputObjIdx,
    outputToSlot,
    inputFromSlot,
    outputFromSlot,
    inputToSlot,
    outputOffset,
    inputOffset,
    recipeId,
    filterId,
    parameters,
  };
  if (marker === -102) {
    b.contentFlag = r.i32();
    if (b.contentFlag > 0) b.content = r.string7();
  }
  return b;
}

function writeBuilding(w: ByteWriter, b: BlueprintBuilding): void {
  const marker: number = b.marker;
  if (marker === -1) {
    w.i32(b.index);
    w.i8(b.areaIndex);
    writeVec3(w, b.localOffset);
    writeVec3(w, b.localOffset2);
    w.f32(b.yaw);
    w.f32(b.yaw2);
    w.i16(b.itemId);
    w.i16(b.modelIndex);
  } else if (marker === -100) {
    w.i32(-100);
    w.i32(b.index);
    w.i8(b.areaIndex);
    writeVec3(w, b.localOffset);
    writeVec3(w, b.localOffset2);
    w.f32(b.yaw);
    w.f32(b.yaw2);
    w.f32(b.tilt);
    w.i16(b.itemId);
    w.i16(b.modelIndex);
  } else if (marker === -101 || marker === -102) {
    w.i32(marker);
    w.i32(b.index);
    w.i16(b.itemId);
    w.i16(b.modelIndex);
    w.i8(b.areaIndex);
    writeVec3(w, b.localOffset);
    w.f32(b.yaw);
    if (isSorter(b.itemId)) {
      w.f32(b.tilt);
      w.f32(b.pitch);
      writeVec3(w, b.localOffset2);
      w.f32(b.yaw2);
      w.f32(b.tilt2);
      w.f32(b.pitch2);
    } else if (isBelt(b.itemId)) {
      w.f32(b.tilt);
    }
  } else {
    throw new BlueprintError('BODY', `building ${b.index}: unknown record marker ${marker}`);
  }

  w.i32(b.outputObjIdx);
  w.i32(b.inputObjIdx);
  w.i8(b.outputToSlot);
  w.i8(b.inputFromSlot);
  w.i8(b.outputFromSlot);
  w.i8(b.inputToSlot);
  w.i8(b.outputOffset);
  w.i8(b.inputOffset);
  w.i16(b.recipeId);
  w.i16(b.filterId);
  w.i16(b.parameters.length);
  for (let i = 0; i < b.parameters.length; i++) w.i32(b.parameters[i]);

  if (marker === -102) {
    const content = b.content ?? '';
    // The value the game writes is unknown (BF §10.2): keep a raw one, else use the content length.
    const flag = b.contentFlag ?? content.length;
    w.i32(flag);
    if (flag > 0) w.string7(content);
  }
}

/**
 * Walk a reform (foundation) block, BF §3.5, starting after the `hasReform` byte. Only its extent
 * matters here: the block is stored raw.
 */
function skipReformBlock(r: ByteReader): void {
  r.u8(); // reserved
  const rectCount = r.i32();
  if (rectCount < 0 || rectCount > MAX_REFORM_RECTS) {
    throw new BlueprintError('BODY', `reform rect count ${rectCount} out of range`);
  }
  r.skip(rectCount * 9);
  r.u32(); // customReformColorMask
  const colorCount = r.i32();
  if (colorCount < 0) throw new BlueprintError('BODY', `reform colour count ${colorCount} out of range`);
  r.skip(colorCount * 4);
}

// mirrors: BlueprintData.Import
/** Parse a decompressed blueprint body. Throws `BlueprintError('BODY')` if it is malformed. */
export function decodeBody(bytes: Uint8Array): BlueprintBody {
  const r = new ByteReader(bytes);
  const version = r.i32();
  const cursorOffsetX = r.i32();
  const cursorOffsetY = r.i32();
  const cursorTargetArea = r.i32();
  const dragBoxSizeX = r.i32();
  const dragBoxSizeY = r.i32();
  const primaryAreaIdx = r.i32();

  const areaCount = r.u8();
  if (areaCount > MAX_AREAS) {
    throw new BlueprintError('BODY', `area count ${areaCount} exceeds ${MAX_AREAS}`);
  }
  const areas: BlueprintArea[] = [];
  for (let i = 0; i < areaCount; i++) areas.push(readArea(r));

  const buildingCount = r.i32();
  if (buildingCount < 0 || buildingCount > MAX_BUILDINGS) {
    throw new BlueprintError('BODY', `building count ${buildingCount} out of range 0..${MAX_BUILDINGS}`);
  }
  const buildings: BlueprintBuilding[] = [];
  for (let i = 0; i < buildingCount; i++) {
    const b = readBuilding(r);
    if (b.index !== i) {
      throw new BlueprintError('BODY', `building at position ${i} has index ${b.index}`);
    }
    for (const [field, link] of [
      ['outputObjIdx', b.outputObjIdx],
      ['inputObjIdx', b.inputObjIdx],
    ] as const) {
      if (link < -1 || link >= buildingCount) {
        throw new BlueprintError('BODY', `building ${i}: ${field} ${link} is out of range`);
      }
    }
    buildings.push(b);
  }

  const body: BlueprintBody = {
    version,
    cursorOffsetX,
    cursorOffsetY,
    cursorTargetArea,
    dragBoxSizeX,
    dragBoxSizeY,
    primaryAreaIdx,
    areas,
    buildings,
  };
  if (version >= 2) {
    body.patch2 = r.i32();
    const reformStart = r.pos;
    if (r.u8() !== 0) skipReformBlock(r);
    body.reformRaw = bytes.slice(reformStart, r.pos);
  }
  if (r.remaining !== 0) {
    throw new BlueprintError('BODY', `${r.remaining} unread byte(s) after the body`);
  }
  return body;
}

// mirrors: BlueprintData.Export
/** Serialise a body. Throws `BlueprintError('BODY')` for values that do not fit their field. */
export function encodeBody(body: BlueprintBody): Uint8Array {
  const w = new ByteWriter();
  w.i32(body.version);
  w.i32(body.cursorOffsetX);
  w.i32(body.cursorOffsetY);
  w.i32(body.cursorTargetArea);
  w.i32(body.dragBoxSizeX);
  w.i32(body.dragBoxSizeY);
  w.i32(body.primaryAreaIdx);

  if (body.areas.length > MAX_AREAS) {
    throw new BlueprintError('BODY', `area count ${body.areas.length} exceeds ${MAX_AREAS}`);
  }
  w.u8(body.areas.length);
  for (const a of body.areas) writeArea(w, a);

  const count = body.buildings.length;
  if (count > MAX_BUILDINGS) {
    throw new BlueprintError('BODY', `building count ${count} exceeds ${MAX_BUILDINGS}`);
  }
  w.i32(count);
  body.buildings.forEach((b, position) => {
    if (b.index !== position) {
      throw new BlueprintError('BODY', `building at position ${position} has index ${b.index}`);
    }
    for (const [field, link] of [
      ['outputObjIdx', b.outputObjIdx],
      ['inputObjIdx', b.inputObjIdx],
    ] as const) {
      if (link < -1 || link >= count) {
        throw new BlueprintError('BODY', `building ${position}: ${field} ${link} is out of range`);
      }
    }
    try {
      writeBuilding(w, b);
    } catch (e) {
      if (e instanceof BlueprintError) throw new BlueprintError(e.code, `building ${position}: ${e.message}`);
      throw e;
    }
  });

  if (body.version >= 2) {
    w.i32(body.patch2 ?? 1);
    w.raw(body.reformRaw ?? Uint8Array.of(0));
  }
  return w.toBytes();
}

// ---------------------------------------------------------------------------------------------
// Envelope (BF §1)

const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const utf8 = new TextEncoder();

function base64Decode(text: string): Uint8Array {
  if (!BASE64.test(text)) throw new BlueprintError('BASE64', 'payload is not valid base64');
  const bin = atob(text);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function base64Encode(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

function gunzip(bytes: Uint8Array): Uint8Array {
  if (bytes.length < 18 || bytes[0] !== 0x1f || bytes[1] !== 0x8b) {
    throw new BlueprintError('GZIP', 'payload is not a gzip stream');
  }
  try {
    return ungzip(bytes);
  } catch (e) {
    throw new BlueprintError('GZIP', `gzip decompression failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** zlib level 6 gzip with MTIME 0 and the given OS byte: what the game's runtime produces (BF §1.2). */
function gzip(raw: Uint8Array, os: number): Uint8Array {
  if (!Number.isInteger(os) || os < 0 || os > 255) {
    throw new BlueprintError('GZIP', `gzip OS byte ${os} does not fit a byte`);
  }
  const deflate = new Deflate({ level: 6, gzip: true, header: { os } });
  deflate.push(raw, true);
  if (deflate.err !== 0) throw new BlueprintError('GZIP', `gzip compression failed: ${deflate.msg}`);
  return deflate.result;
}

export interface DecodeOptions {
  /** Check the trailing MD5F hash first (default true). */
  verifyHash?: boolean;
}

/**
 * Parse a `BLUEPRINT:` string. Throws `BlueprintError` whose `code` names the failing stage; with the
 * default options the MD5F hash is checked before anything else is parsed.
 */
export function decodeBlueprint(str: string, options: DecodeOptions = {}): Blueprint {
  const verifyHash = options.verifyHash ?? true;
  const s = str.trim();
  if (!s.startsWith(PREFIX)) {
    throw new BlueprintError('NOT_BLUEPRINT', `string does not start with ${PREFIX}`);
  }
  const q1 = s.indexOf('"');
  if (q1 < 0) throw new BlueprintError('HEADER', 'no quote ends the header');
  const q2 = s.lastIndexOf('"');

  if (verifyHash) {
    const stored = s.slice(q2 + 1, q2 + 1 + HASH_LENGTH);
    const actual = md5f(utf8.encode(s.slice(0, q2)));
    if (stored !== actual) {
      throw new BlueprintError('HASH', `hash mismatch: stored ${JSON.stringify(stored)}, computed ${actual}`);
    }
  }

  const header = parseHeader(s.slice(PREFIX.length, q1).split(','));
  if (q2 === q1) throw new BlueprintError('BASE64', 'payload is not closed by a second quote');

  const gz = base64Decode(s.slice(q1 + 1, q2));
  const raw = gunzip(gz);
  const body = decodeBody(raw);
  return { header, body, gzipOs: gz[9] };
}

/** Serialise to a `BLUEPRINT:` string with a valid MD5F hash. See {@link BlueprintHeader.rawCells}. */
export function encodeBlueprint(bp: Blueprint): string {
  const head = PREFIX + headerCells(bp.header).join(',');
  const gz = gzip(encodeBody(bp.body), bp.gzipOs);
  const text = `${head}"${base64Encode(gz)}`;
  return `${text}"${md5f(utf8.encode(text))}`;
}
