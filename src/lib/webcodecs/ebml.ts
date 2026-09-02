// EBML — the binary grammar Matroska is written in. Everything in an .mkv is a nested element:
// a variable-length id, a variable-length size, then either child elements or a payload.
//
// Written by hand rather than pulled from a library: the demuxer needs only a small slice of the
// format, this keeps it fully testable in CI with no WebAssembly blob, and the parsing is
// mechanical enough that the risk lives in the details (unknown sizes, lacing) rather than in
// the primitives.

import type { ByteSource } from "./byteSource";

export interface EbmlElement {
  id: number;
  /** Payload length. Null for the "unknown size" encoding, used by streamed clusters. */
  size: number | null;
  /** Absolute offset of the payload's first byte. */
  offset: number;
  /** Bytes taken by the id + size fields themselves. */
  headerSize: number;
}

// The leading zero count of the first byte gives the total width, for both ids and sizes.
function widthOf(firstByte: number): number {
  for (let width = 1; width <= 8; width++) {
    if (firstByte & (0x80 >> (width - 1))) return width;
  }
  return 0; // invalid — no marker bit in the first byte
}

/** Element ids keep their marker bit: 0x1A45DFA3 is the id, not 0x0A45DFA3. */
export function readElementId(bytes: Uint8Array, at: number): { value: number; width: number } | null {
  if (at >= bytes.length) return null;
  const width = widthOf(bytes[at]);
  if (width === 0 || at + width > bytes.length) return null;
  let value = 0;
  for (let i = 0; i < width; i++) value = value * 256 + bytes[at + i];
  return { value, width };
}

/** Sizes drop their marker bit. All-ones means "unknown", which this returns as null. */
export function readVarSize(bytes: Uint8Array, at: number): { value: number | null; width: number } | null {
  if (at >= bytes.length) return null;
  const width = widthOf(bytes[at]);
  if (width === 0 || at + width > bytes.length) return null;

  let value = bytes[at] & (0xff >> width);
  let allOnes = value === (0xff >> width);
  for (let i = 1; i < width; i++) {
    const byte = bytes[at + i];
    if (byte !== 0xff) allOnes = false;
    value = value * 256 + byte;
  }
  return { value: allOnes ? null : value, width };
}

/** A signed variable-length integer, as used by lacing. */
export function readVarInt(bytes: Uint8Array, at: number): { value: number; width: number } | null {
  const raw = readVarSize(bytes, at);
  if (!raw || raw.value === null) return null;
  // Range shifts by half the addressable space for the given width.
  const bias = 2 ** (7 * raw.width - 1) - 1;
  return { value: raw.value - bias, width: raw.width };
}

export function readUint(bytes: Uint8Array): number {
  let value = 0;
  for (const byte of bytes) value = value * 256 + byte;
  return value;
}

export function readFloat(bytes: Uint8Array): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length === 4) return view.getFloat32(0);
  if (bytes.length === 8) return view.getFloat64(0);
  return 0;
}

export function readString(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes).replace(/\0+$/, "");
}

// Element headers are at most 12 bytes (8 + 4 is already beyond anything real), but reads go
// through a chunk cache, so asking for a generous window costs nothing and avoids a second
// round-trip when the size field straddles the first read.
const HEADER_WINDOW = 16;

export async function readElementAt(source: ByteSource, offset: number): Promise<EbmlElement | null> {
  if (offset >= source.size) return null;
  const window = await source.read(offset, HEADER_WINDOW);
  const id = readElementId(window, 0);
  if (!id) return null;
  const size = readVarSize(window, id.width);
  if (!size) return null;
  const headerSize = id.width + size.width;
  return { id: id.value, size: size.value, offset: offset + headerSize, headerSize };
}

/**
 * Walks the direct children of a container, calling `visit` for each. Returning "stop" from the
 * visitor ends the walk — used to bail out of a 40 GB Segment as soon as the wanted element has
 * been read, instead of parsing everything to the end of the file.
 */
export type EbmlVisit = (element: EbmlElement) => unknown;

export async function forEachChild(
  source: ByteSource,
  start: number,
  end: number,
  // Deliberately loose in its return type: only the exact string "stop" ends the walk, and
  // anything else — including the "continue" the callers write for readability — carries on.
  // Typing it as a literal union instead forces every async visitor to be annotated, since
  // TypeScript widens a returned string literal to `string` inside an async arrow.
  visit: EbmlVisit
): Promise<void> {
  let cursor = start;
  while (cursor < end) {
    const element = await readElementAt(source, cursor);
    if (!element) return;
    if (element.size !== null && element.offset + element.size > end + element.headerSize) {
      // A child claiming to run past its parent means the file is damaged or we lost alignment;
      // continuing would read garbage as structure.
      return;
    }
    if ((await visit(element)) === "stop") return;
    // An unknown-size element can only be the last thing we can safely walk here: without a
    // length there is no way to know where its siblings resume.
    if (element.size === null) return;
    cursor = element.offset + element.size;
  }
}
