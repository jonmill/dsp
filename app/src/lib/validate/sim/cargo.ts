// The unit that rides a belt (MX §2.1, §2.2): one item kind, a stack of 1 to 4 items, and the total
// proliferator points `inc` of that stack. The simulator keeps cargo packed into one int32 per cargo so that
// belt buffers stay typed arrays and the per-tick update allocates nothing.

export interface Cargo {
  item: number;
  /** 1 to `MAX_CARGO_STACK`. */
  stack: number;
  /** Total proliferator points of the whole stack. */
  inc: number;
}

/** Cells one cargo occupies on a belt (`CargoPath.kCargoLength`, MX §2.2). */
export const CARGO_LENGTH = 10;

/** The most items one cargo holds (MX §2.1). */
export const MAX_CARGO_STACK = 4;

// Layout of a packed cargo: item in bits 0-15, stack in bits 16-19, inc in bits 20-29. Positive int32.
const ITEM_BITS = 16;
const STACK_BITS = 4;
const ITEM_MASK = (1 << ITEM_BITS) - 1;
const STACK_MASK = (1 << STACK_BITS) - 1;
const INC_MAX = (1 << 10) - 1;

/** The int32 form of `c`. Throws RangeError if a field does not fit (item 0..65535, stack 1..4, inc 0..1023). */
export function packCargo(c: Cargo): number {
  const { item, stack, inc } = c;
  if (!Number.isInteger(item) || item < 0 || item > ITEM_MASK) throw new RangeError(`cargo item ${item} out of range`);
  if (!Number.isInteger(stack) || stack < 1 || stack > MAX_CARGO_STACK) {
    throw new RangeError(`cargo stack ${stack} must be 1..${MAX_CARGO_STACK}`);
  }
  if (!Number.isInteger(inc) || inc < 0 || inc > INC_MAX) throw new RangeError(`cargo inc ${inc} out of range`);
  return item | (stack << ITEM_BITS) | (inc << (ITEM_BITS + STACK_BITS));
}

/** The item id of a packed cargo. */
export const packedItem = (packed: number): number => packed & ITEM_MASK;

/** The stack of a packed cargo. */
export const packedStack = (packed: number): number => (packed >>> ITEM_BITS) & STACK_MASK;

/** The proliferator points of a packed cargo. */
export const packedInc = (packed: number): number => packed >>> (ITEM_BITS + STACK_BITS);

/** A fresh `Cargo` from its packed form. */
export function unpackCargo(packed: number): Cargo {
  return { item: packedItem(packed), stack: packedStack(packed), inc: packedInc(packed) };
}
