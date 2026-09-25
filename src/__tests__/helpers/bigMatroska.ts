/**
 * Un Matroska synthétique assez grand pour s'étendre sur plusieurs morceaux de 1 Mio : une grappe
 * par seconde, chacune ouverte par une image clé, une image intermédiaire et un bloc de son, un index
 * complet à la fin — la disposition d'un vrai fichier fait pour le streaming. Même écriture que le
 * petit fichier de `webcodecs-matroska.test.ts`, en plus grand.
 */

function vint(value: number): Uint8Array {
  let w = 1;
  while (value >= 2 ** (7 * w) - 1 && w < 8) w++;
  const out = new Uint8Array(w);
  let v = value;
  for (let i = w - 1; i >= 0; i--) {
    out[i] = v & 0xff;
    v = Math.floor(v / 256);
  }
  out[0] |= 0x80 >> (w - 1);
  return out;
}

function idBytes(id: number): Uint8Array {
  const parts: number[] = [];
  let v = id;
  while (v > 0) {
    parts.unshift(v & 0xff);
    v = Math.floor(v / 256);
  }
  return new Uint8Array(parts);
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

function el(id: number, payload: Uint8Array): Uint8Array {
  return concat(idBytes(id), vint(payload.length), payload);
}

function uint(value: number, bytes = 1): Uint8Array {
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

function simpleBlock(track: number, relative: number, isKey: boolean, data: Uint8Array): Uint8Array {
  const header = new Uint8Array(4);
  header[0] = 0x80 | track;
  new DataView(header.buffer).setInt16(1, relative);
  header[3] = isKey ? 0x80 : 0x00;
  return el(0xa3, concat(header, data));
}

/** @param seconds grappes d'une seconde ; @param keyBytes taille de chaque image clé. */
export function bigMatroska(seconds = 40, keyBytes = 300_000): Uint8Array {
  const ebmlHeader = el(0x1a45dfa3, el(0x4286, uint(1)));
  const info = el(0x1549a966, concat(el(0x2ad7b1, uint(1_000_000, 4)), el(0x4489, f64(seconds * 1000))));
  const video = el(
    0xae,
    concat(
      el(0xd7, uint(1)),
      el(0x83, uint(1)),
      el(0x86, new TextEncoder().encode("V_MPEG4/ISO/AVC")),
      el(0x63a2, new Uint8Array([1, 0x64, 0, 0x28, 0xff, 0xe0, 0])),
      el(0xe0, concat(el(0xb0, uint(1920, 2)), el(0xba, uint(1080, 2))))
    )
  );
  const audio = el(
    0xae,
    concat(
      el(0xd7, uint(2)),
      el(0x83, uint(2)),
      el(0x86, new TextEncoder().encode("A_AAC")),
      el(0x63a2, new Uint8Array([0x11, 0x90])),
      el(0xe1, concat(el(0xb5, f64(48000)), el(0x9f, uint(2))))
    )
  );
  const tracks = el(0x1654ae6b, concat(video, audio));

  const clusters: Uint8Array[] = [];
  for (let s = 0; s < seconds; s++) {
    const key = new Uint8Array(keyBytes).fill(s & 0xff);
    clusters.push(
      el(
        0x1f43b675,
        concat(
          el(0xe7, uint(s * 1000, 4)),
          simpleBlock(1, 0, true, key),
          simpleBlock(2, 0, true, new Uint8Array(2_000).fill(0x55)),
          simpleBlock(1, 500, false, new Uint8Array(20_000).fill(0x33))
        )
      )
    );
  }

  const cuesFor = (positions: number[]) =>
    el(
      0x1c53bb6b,
      concat(...positions.map((p, s) => el(0xbb, concat(el(0xb3, uint(s * 1000, 4)), el(0xb7, concat(el(0xf7, uint(1)), el(0xf1, uint(p, 6))))))))
    );
  const seekHeadFor = (cuesPosition: number) =>
    el(0x114d9b74, el(0x4dbb, concat(el(0x53ab, idBytes(0x1c53bb6b)), el(0x53ac, uint(cuesPosition, 6)))));

  const headLength = seekHeadFor(0).length + info.length + tracks.length;
  const positions: number[] = [];
  let at = headLength;
  for (const cluster of clusters) {
    positions.push(at);
    at += cluster.length;
  }
  const segmentPayload = concat(seekHeadFor(at), info, tracks, ...clusters, cuesFor(positions));
  return concat(ebmlHeader, el(0x18538067, segmentPayload));
}
