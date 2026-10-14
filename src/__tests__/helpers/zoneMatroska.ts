// Des Matroska fabriqués en mémoire pour la zone illisible (DECISIONS.md §93) : six grappes de 2 s,
// un index par grappe, et de quoi les abîmer comme « Le Grinch » l'était. Partagé par les tests du
// lecteur (`unreadable-zone.test.ts`) et ceux de la vérification d'intégrité.

export function vint(value: number, width = 0): Uint8Array {
  let w = width;
  if (!w) {
    w = 1;
    while (value >= 2 ** (7 * w) - 1 && w < 8) w++;
  }
  const out = new Uint8Array(w);
  let v = value;
  for (let i = w - 1; i >= 0; i--) {
    out[i] = v & 0xff;
    v = Math.floor(v / 256);
  }
  out[0] |= 0x80 >> (w - 1);
  return out;
}
export function idBytes(id: number): Uint8Array {
  const parts: number[] = [];
  let v = id;
  while (v > 0) {
    parts.unshift(v & 0xff);
    v = Math.floor(v / 256);
  }
  return new Uint8Array(parts);
}
export function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
export function el(id: number, payload: Uint8Array): Uint8Array {
  return concat(idBytes(id), vint(payload.length), payload);
}
export function uint(value: number, bytes = 1): Uint8Array {
  const out = new Uint8Array(bytes);
  let v = value;
  for (let i = bytes - 1; i >= 0; i--) {
    out[i] = v & 0xff;
    v = Math.floor(v / 256);
  }
  return out;
}
function f64(value: number): Uint8Array {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setFloat64(0, value);
  return out;
}
/** Un bloc dont le contenu est fait d'octets non nuls (jamais une zone par lui-même). */
function payloadOf(seed: number, length: number): Uint8Array {
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i++) out[i] = 1 + ((seed * 31 + i * 7) % 250);
  return out;
}
function simpleBlock(track: number, relative: number, isKey: boolean, data: Uint8Array): Uint8Array {
  const header = new Uint8Array(4);
  header[0] = 0x80 | track;
  new DataView(header.buffer).setInt16(1, relative);
  header[3] = isKey ? 0x80 : 0x00;
  return el(0xa3, concat(header, data));
}
function blockGroup(track: number, relative: number, data: Uint8Array, reference: boolean): Uint8Array {
  const header = new Uint8Array(4);
  header[0] = 0x80 | track;
  new DataView(header.buffer).setInt16(1, relative);
  return el(0xa0, concat(el(0xa1, concat(header, data)), ...(reference ? [el(0xfb, uint(1))] : []), el(0x9b, uint(40))));
}

export const CLUSTER_MS = 2000;

export interface Built {
  bytes: Uint8Array;
  /** Où commence chaque grappe (absolu). */
  clusters: number[];
  /** Où commence chaque bloc de chaque grappe (absolu) — l'en-tête de l'élément. */
  blocks: number[][];
  segmentEnd: number;
}

/**
 * Six grappes de 2 s : un horodatage, cinq blocs (trois images, deux sons), l'index de chaque grappe
 * à la fin, une SeekHead devant. Options : sans index, segment de taille inconnue, octets en trop
 * entre la dernière grappe et l'index (dans le segment), blocs en groupes.
 */
export function build(options: { cues?: boolean; unknownSegment?: boolean; trailing?: Uint8Array; groups?: boolean; count?: number } = {}): Built {
  const count = options.count ?? 6;
  const ebmlHeader = el(0x1a45dfa3, el(0x4286, uint(1)));
  const info = el(0x1549a966, concat(el(0x2ad7b1, uint(1_000_000, 4)), el(0x4489, f64(count * CLUSTER_MS))));
  const video = el(0xae, concat(el(0xd7, uint(1)), el(0x83, uint(1)), el(0x86, new TextEncoder().encode("V_MPEGH/ISO/HEVC")), el(0xe0, concat(el(0xb0, uint(1920, 2)), el(0xba, uint(1080, 2))))));
  const audio = el(0xae, concat(el(0xd7, uint(2)), el(0x83, uint(2)), el(0x86, new TextEncoder().encode("A_EAC3")), el(0xe1, concat(el(0xb5, f64(48000)), el(0x9f, uint(6))))));
  const tracks = el(0x1654ae6b, concat(video, audio));

  const clusterBodies: { body: Uint8Array; blockAt: number[] }[] = [];
  for (let c = 0; c < count; c++) {
    const parts: Uint8Array[] = [el(0xe7, uint(c * CLUSTER_MS, 2))];
    const blockAt: number[] = [];
    let at = parts[0].length;
    const push = (b: Uint8Array) => {
      blockAt.push(at);
      parts.push(b);
      at += b.length;
    };
    for (let i = 0; i < 3; i++) {
      const data = payloadOf(c * 10 + i, 300 + i * 40);
      push(options.groups ? blockGroup(1, i * 600, data, i > 0) : simpleBlock(1, i * 600, i === 0, data));
      if (i < 2) push(options.groups ? blockGroup(2, i * 600 + 10, payloadOf(c * 10 + i + 5, 120), false) : simpleBlock(2, i * 600 + 10, true, payloadOf(c * 10 + i + 5, 120)));
    }
    clusterBodies.push({ body: concat(...parts), blockAt });
  }
  const clusters = clusterBodies.map((c) => el(0x1f43b675, c.body));
  const headerOf = (c: number) => clusters[c].length - clusterBodies[c].body.length;

  const seekHeadFor = (cuesPosition: number) => el(0x114d9b74, el(0x4dbb, concat(el(0x53ab, idBytes(0x1c53bb6b)), el(0x53ac, uint(cuesPosition, 6)))));
  const seekHeadLength = seekHeadFor(0).length;
  const positions: number[] = [];
  let pos = seekHeadLength + info.length + tracks.length;
  for (const c of clusters) {
    positions.push(pos);
    pos += c.length;
  }
  const trailing = options.trailing ?? new Uint8Array(0);
  const cuesPosition = pos + trailing.length;
  const cues =
    options.cues === false
      ? new Uint8Array(0)
      : el(0x1c53bb6b, concat(...positions.map((p, c) => el(0xbb, concat(el(0xb3, uint(c * CLUSTER_MS, 2)), el(0xb7, concat(el(0xf7, uint(1)), el(0xf1, uint(p, 6)))))))));
  const payload = concat(options.cues === false ? new Uint8Array(0) : seekHeadFor(cuesPosition), ...(options.cues === false ? [new Uint8Array(seekHeadLength).fill(0xec)] : []), info, tracks, ...clusters, trailing, cues);
  // Sans index, la SeekHead est remplacée par un élément Void de même longueur (0xEC, taille comprise).
  if (options.cues === false) {
    const voidEl = concat(new Uint8Array([0xec]), vint(seekHeadLength - 2, 1), new Uint8Array(seekHeadLength - 2));
    payload.set(voidEl, 0);
  }
  const segmentHead = options.unknownSegment ? concat(idBytes(0x18538067), new Uint8Array([0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff])) : concat(idBytes(0x18538067), vint(payload.length));
  const bytes = concat(ebmlHeader, segmentHead, payload);
  const dataStart = ebmlHeader.length + segmentHead.length;
  return {
    bytes,
    clusters: positions.map((p) => dataStart + p),
    blocks: positions.map((p, c) => clusterBodies[c].blockAt.map((b) => dataStart + p + headerOf(c) + b)),
    segmentEnd: dataStart + payload.length,
  };
}

export function damaged(bytes: Uint8Array, ...zones: [number, number][]): Uint8Array {
  const copy = bytes.slice();
  for (const [at, length] of zones) copy.fill(0, at, Math.min(copy.length, at + length));
  return copy;
}
