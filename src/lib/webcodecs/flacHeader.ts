// L'en-tête FLAC donné à libFLAC — partagé par le décodeur enregistré auprès de mediabunny
// (flacDecoder.ts) et par la chaîne « Son par Lumen » (ownAudio.ts), qui ne charge pas mediabunny.

/**
 * The stream header libFLAC is given: "fLaC" and STREAMINFO, marked as the last block — nothing
 * else of Matroska's CodecPrivate.
 *
 * The rest is padding, tags, a seek table: nothing a decoder needs, and one of them broke it.
 * *Le Retour de Martin Guerre* (21/09/2026) carries 8 KiB of PADDING after STREAMINFO; handed
 * the whole header, libFLAC corrupted its own heap and died at the 260th packet — 25 s in —
 * with "Out of bounds memory access" in `malloc`, and the film went to the server player. The
 * same file decodes to its last packet (70 389) on STREAMINFO alone; the tags alone are
 * harmless, the padding alone is enough to crash it. Measured in Node, on the real file, with
 * the same decoder the browser runs. A header that does not open on STREAMINFO is passed as it
 * came: the format requires it first, and guessing at a malformed one would be worse.
 */
export function streamInfoHeader(header: Uint8Array): Uint8Array {
  const magic = header.length >= 4 && header[0] === 0x66 && header[1] === 0x4c && header[2] === 0x61 && header[3] === 0x43;
  const at = magic ? 4 : 0;
  if (header.length < at + 4 || (header[at] & 0x7f) !== 0) return header.slice();
  const length = (header[at + 1] << 16) | (header[at + 2] << 8) | header[at + 3];
  if (header.length < at + 4 + length) return header.slice();
  const out = new Uint8Array(4 + 4 + length);
  out.set([0x66, 0x4c, 0x61, 0x43]);
  out.set(header.subarray(at, at + 4 + length), 4);
  out[4] |= 0x80; // last metadata block
  return out;
}
