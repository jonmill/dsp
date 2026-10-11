/** In-memory model of a DSP factory blueprint (format reference: docs/research/blueprint-format.md, "BF"). */

/** Which building record layout a building was read from / is written as. -1 = legacy (no marker). */
export type BuildingMarker = -1 | -100 | -101 | -102;

export interface BlueprintArea {
  index: number;
  parentIndex: number;
  tropicAnchor: number;
  areaSegments: number;
  anchorLocalOffsetX: number;
  anchorLocalOffsetY: number;
  width: number;
  height: number;
}

export interface BlueprintBuilding {
  marker: BuildingMarker;
  index: number;
  areaIndex: number;
  localOffset: [number, number, number];
  localOffset2: [number, number, number];
  yaw: number;
  yaw2: number;
  tilt: number;
  pitch: number;
  tilt2: number;
  pitch2: number;
  itemId: number;
  modelIndex: number;
  outputObjIdx: number;
  inputObjIdx: number;
  outputToSlot: number;
  inputFromSlot: number;
  outputFromSlot: number;
  inputToSlot: number;
  outputOffset: number;
  inputOffset: number;
  recipeId: number;
  filterId: number;
  /** Opaque building parameters; the exact length is part of the data (BF §4). */
  parameters: Int32Array;
  /** -102 only: the raw int32 written before the content string; the string is present iff `> 0`. */
  contentFlag?: number;
  /** -102 only: UTF-8 text, present iff `contentFlag > 0`. */
  content?: string;
}

export interface BlueprintHeader {
  /**
   * The header cells exactly as read (comma-split text between `BLUEPRINT:` and the first `"`).
   * Encoding re-emits a raw cell whenever the field it feeds still decodes to the same value, so an
   * untouched header round-trips byte for byte. Use `[]` for a header built from scratch.
   */
  rawCells: string[];
  /** 0 or 1 (BF §1.1). */
  headerVersion: number;
  /** `EIconLayout` value. */
  layout: number;
  icons: [number, number, number, number, number];
  /** .NET `DateTime.Ticks` (100 ns units since 0001-01-01, local time): exceeds 2^53, hence bigint. */
  ticks: bigint;
  gameVersion: string;
  /** Unescaped text. */
  shortDesc: string;
  /** Unescaped text. */
  desc: string;
  /** Header v1 only; unescaped text. */
  author?: string;
  customVersion?: string;
  attributes?: string;
}

export interface BlueprintBody {
  version: number;
  cursorOffsetX: number;
  cursorOffsetY: number;
  cursorTargetArea: number;
  dragBoxSizeX: number;
  dragBoxSizeY: number;
  primaryAreaIdx: number;
  areas: BlueprintArea[];
  buildings: BlueprintBuilding[];
  /** Version >= 2 trailer: the reserved int32 (observed 1). */
  patch2?: number;
  /**
   * Version >= 2 trailer: the `hasReform` byte and, when it is non-zero, the foundation block that
   * follows it, kept verbatim (BF §3.5). `[0]` means no foundation data.
   */
  reformRaw?: Uint8Array;
}

export interface Blueprint {
  header: BlueprintHeader;
  body: BlueprintBody;
  /** Byte 9 (OS) of the gzip header; the game does not check it but byte-exact output keeps it. */
  gzipOs: number;
}

export type BlueprintErrorCode = 'NOT_BLUEPRINT' | 'HEADER' | 'BASE64' | 'GZIP' | 'BODY' | 'HASH';

/** Thrown by the codec. `code` says which stage rejected the input; `message` says why. */
export class BlueprintError extends Error {
  readonly code: BlueprintErrorCode;

  constructor(code: BlueprintErrorCode, message: string) {
    super(message);
    this.name = 'BlueprintError';
    this.code = code;
  }
}
