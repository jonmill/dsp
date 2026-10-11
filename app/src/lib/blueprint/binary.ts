import { BlueprintError } from './model';

/** Little-endian cursor over a byte buffer. Every read past the end throws `BlueprintError('BODY')`. */
export class ByteReader {
  readonly data: Uint8Array;
  private readonly view: DataView;
  pos = 0;

  constructor(data: Uint8Array) {
    this.data = data;
    this.view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  }

  get remaining(): number {
    return this.data.length - this.pos;
  }

  /** Reserve `n` bytes and return the offset they start at. */
  private take(n: number): number {
    if (n > this.remaining) {
      throw new BlueprintError(
        'BODY',
        `unexpected end of data: need ${n} byte(s) at offset ${this.pos}, only ${this.remaining} left`,
      );
    }
    const at = this.pos;
    this.pos += n;
    return at;
  }

  u8(): number {
    return this.view.getUint8(this.take(1));
  }
  i8(): number {
    return this.view.getInt8(this.take(1));
  }
  i16(): number {
    return this.view.getInt16(this.take(2), true);
  }
  i32(): number {
    return this.view.getInt32(this.take(4), true);
  }
  u32(): number {
    return this.view.getUint32(this.take(4), true);
  }
  f32(): number {
    return this.view.getFloat32(this.take(4), true);
  }

  skip(n: number): void {
    this.take(n);
  }

  /** Copy of the next `n` bytes. */
  bytes(n: number): Uint8Array {
    const at = this.take(n);
    return this.data.slice(at, at + n);
  }

  /** .NET `BinaryReader.Read7BitEncodedInt`. */
  int7(): number {
    let result = 0;
    for (let shift = 0; shift < 35; shift += 7) {
      const b = this.u8();
      result += (b & 0x7f) * 2 ** shift;
      if ((b & 0x80) === 0) return result;
    }
    throw new BlueprintError('BODY', `malformed 7-bit encoded integer ending at offset ${this.pos}`);
  }

  /** .NET `BinaryReader.ReadString`: 7-bit encoded UTF-8 byte length, then the bytes. */
  string7(): string {
    const len = this.int7();
    return new TextDecoder().decode(this.bytes(len));
  }
}

const INT_RANGES = {
  uint8: [0, 0xff],
  int8: [-0x80, 0x7f],
  int16: [-0x8000, 0x7fff],
  int32: [-0x80000000, 0x7fffffff],
  uint32: [0, 0xffffffff],
} as const;

/** Growable little-endian writer. Integer writes throw `BlueprintError('BODY')` instead of wrapping. */
export class ByteWriter {
  private buf = new Uint8Array(256);
  private view = new DataView(this.buf.buffer);
  private len = 0;

  get length(): number {
    return this.len;
  }

  private reserve(n: number): number {
    const need = this.len + n;
    if (need > this.buf.length) {
      let cap = this.buf.length;
      while (cap < need) cap *= 2;
      const next = new Uint8Array(cap);
      next.set(this.buf.subarray(0, this.len));
      this.buf = next;
      this.view = new DataView(next.buffer);
    }
    const at = this.len;
    this.len = need;
    return at;
  }

  private checkInt(kind: keyof typeof INT_RANGES, v: number): void {
    const [lo, hi] = INT_RANGES[kind];
    if (!Number.isInteger(v) || v < lo || v > hi) {
      throw new BlueprintError('BODY', `value ${v} does not fit ${kind}`);
    }
  }

  u8(v: number): void {
    this.checkInt('uint8', v);
    const at = this.reserve(1);
    this.view.setUint8(at, v);
  }
  i8(v: number): void {
    this.checkInt('int8', v);
    const at = this.reserve(1);
    this.view.setInt8(at, v);
  }
  i16(v: number): void {
    this.checkInt('int16', v);
    const at = this.reserve(2);
    this.view.setInt16(at, v, true);
  }
  i32(v: number): void {
    this.checkInt('int32', v);
    const at = this.reserve(4);
    this.view.setInt32(at, v, true);
  }
  u32(v: number): void {
    this.checkInt('uint32', v);
    const at = this.reserve(4);
    this.view.setUint32(at, v, true);
  }
  f32(v: number): void {
    if (typeof v !== 'number' || !Number.isFinite(Math.fround(v))) {
      throw new BlueprintError('BODY', `value ${v} is not a finite float32`);
    }
    const at = this.reserve(4);
    this.view.setFloat32(at, v, true);
  }

  raw(bytes: Uint8Array): void {
    const at = this.reserve(bytes.length);
    this.buf.set(bytes, at);
  }

  /** .NET `BinaryWriter.Write7BitEncodedInt` for a non-negative value. */
  int7(v: number): void {
    this.checkInt('int32', v);
    if (v < 0) throw new BlueprintError('BODY', `value ${v} is not a valid 7-bit encoded length`);
    let rest = v;
    while (rest >= 0x80) {
      this.u8((rest & 0x7f) | 0x80);
      rest = Math.floor(rest / 128);
    }
    this.u8(rest);
  }

  /** .NET `BinaryWriter.Write(string)`: 7-bit encoded UTF-8 byte length, then the bytes. */
  string7(s: string): void {
    const bytes = new TextEncoder().encode(s);
    this.int7(bytes.length);
    this.raw(bytes);
  }

  toBytes(): Uint8Array {
    return this.buf.slice(0, this.len);
  }
}
