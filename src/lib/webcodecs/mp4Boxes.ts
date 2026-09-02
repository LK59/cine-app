// Byte-level primitives for writing MP4.
//
// An MP4 file is a tree of "boxes": a 32-bit length, a four-character type, then either child
// boxes or a payload. Everything else in the muxer is built from these few functions, which is
// why they are deliberately dull — a mistake here produces a file that is structurally wrong in
// a way no error message will ever describe.

export function u8(value: number): Uint8Array {
  return new Uint8Array([value & 0xff]);
}

export function u16(value: number): Uint8Array {
  return new Uint8Array([(value >> 8) & 0xff, value & 0xff]);
}

export function u24(value: number): Uint8Array {
  return new Uint8Array([(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff]);
}

export function u32(value: number): Uint8Array {
  // Unsigned, so the shift is done with division rather than >>, which would sign-extend past 2^31.
  return new Uint8Array([
    Math.floor(value / 0x1000000) & 0xff,
    (value >> 16) & 0xff,
    (value >> 8) & 0xff,
    value & 0xff,
  ]);
}

export function i32(value: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setInt32(0, value);
  return out;
}

/** 64-bit, written as two 32-bit halves — media timelines outgrow 32 bits on a long film. */
export function u64(value: number): Uint8Array {
  const high = Math.floor(value / 0x100000000);
  const low = value >>> 0 === value ? value : value - high * 0x100000000;
  return concat(u32(high), u32(low >>> 0));
}

/** A four-character box type or brand. */
export function fourcc(type: string): Uint8Array {
  if (type.length !== 4) throw new Error(`Type de boîte invalide : "${type}"`);
  const out = new Uint8Array(4);
  for (let i = 0; i < 4; i++) out[i] = type.charCodeAt(i) & 0xff;
  return out;
}

export function concat(...parts: Uint8Array[]): Uint8Array {
  let length = 0;
  for (const part of parts) length += part.length;
  const out = new Uint8Array(length);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

export function zeros(count: number): Uint8Array {
  return new Uint8Array(count);
}

/** A plain box: its own length (header included), its type, then its contents. */
export function box(type: string, ...contents: Uint8Array[]): Uint8Array {
  const body = concat(...contents);
  return concat(u32(body.length + 8), fourcc(type), body);
}

/**
 * A "full box" — the same, plus a version byte and 24 bits of flags. Which boxes are full and
 * which are plain is fixed by the specification, not by choice.
 */
export function fullBox(type: string, version: number, flags: number, ...contents: Uint8Array[]): Uint8Array {
  return box(type, u8(version), u24(flags), ...contents);
}

/** 16.16 fixed point, as the header boxes use for rates and dimensions. */
export function fixed16(value: number): Uint8Array {
  return u32(Math.round(value * 0x10000));
}

/** 8.8 fixed point, used for volume. */
export function fixed8(value: number): Uint8Array {
  return u16(Math.round(value * 0x100));
}

/**
 * The identity transformation matrix every track header carries.
 *
 * The first six entries are 16.16 fixed point, but the last three are 2.30 — so the 1.0 in the
 * bottom-right corner is 0x40000000, not 0x00010000 and not 0x4000. A wrong value there is a
 * degenerate transform that a strict player divides the coordinates by.
 */
export const UNITY_MATRIX = concat(
  fixed16(1), u32(0), u32(0),
  u32(0), fixed16(1), u32(0),
  u32(0), u32(0), u32(0x40000000)
);
