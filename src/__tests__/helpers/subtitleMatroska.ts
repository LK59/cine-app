/**
 * Un petit Matroska fabriqué en mémoire avec des pistes de sous-titres texte — pour la recherche de
 * répliques (DECISIONS.md §88). Une piste vidéo (des blocs de remplissage), des pistes texte, une
 * grappe par seconde, et un index (Cues) qui désigne chaque réplique avec `CueRelativePosition` et
 * `CueDuration`, comme mkvmerge l'écrit — ou pas d'index pour les pistes texte, pour le repli.
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

/** Une taille sur 8 octets, comme ffmpeg l'écrit pour les grappes (la lecture ciblée doit la deviner). */
function elWide(id: number, payload: Uint8Array): Uint8Array {
  const size = new Uint8Array(8);
  let v = payload.length;
  for (let i = 7; i >= 1; i--) {
    size[i] = v & 0xff;
    v = Math.floor(v / 256);
  }
  size[0] = 0x01;
  return concat(idBytes(id), size, payload);
}

function uint(value: number, bytes = 4): Uint8Array {
  const out = new Uint8Array(bytes);
  let v = value;
  for (let i = bytes - 1; i >= 0; i--) {
    out[i] = v & 0xff;
    v = Math.floor(v / 256);
  }
  return out;
}

const text = (s: string) => new TextEncoder().encode(s);

function blockPayload(track: number, relative: number, data: Uint8Array, key = true): Uint8Array {
  const header = new Uint8Array(4);
  header[0] = 0x80 | track;
  new DataView(header.buffer).setInt16(1, relative);
  header[3] = key ? 0x80 : 0;
  return concat(header, data);
}

export interface SubTrackSpec {
  number: number;
  codec: string;
  language: string;
  name?: string;
  forced?: boolean;
  hearingImpaired?: boolean;
  /** Une réplique par seconde de la liste : [seconde, durée en ms, texte]. */
  lines: [number, number, string][];
  /** Absente de l'index (pas de `CueTrackPositions`) : seule la lecture complète la trouve. */
  unindexed?: boolean;
  /** Dans un `BlockGroup` avec `BlockDuration`, plutôt qu'un `SimpleBlock`. */
  blockGroup?: boolean;
}

export function subtitleMatroska(seconds: number, tracks: SubTrackSpec[], filler = 2000, wideClusters = false): Uint8Array {
  const ebmlHeader = el(0x1a45dfa3, el(0x4282, text("matroska")));
  const info = el(0x1549a966, el(0x2ad7b1, uint(1_000_000)));
  const entries = [
    el(0xae, concat(el(0xd7, uint(1, 1)), el(0x83, uint(1, 1)), el(0x86, text("V_MPEG4/ISO/AVC")), el(0xe0, concat(el(0xb0, uint(640, 2)), el(0xba, uint(360, 2)))))),
    ...tracks.map((t) =>
      el(
        0xae,
        concat(
          el(0xd7, uint(t.number, 1)),
          el(0x83, uint(17, 1)),
          el(0x86, text(t.codec)),
          el(0x22b59c, text(t.language)),
          t.name ? el(0x536e, text(t.name)) : new Uint8Array(0),
          t.forced ? el(0x55aa, uint(1, 1)) : new Uint8Array(0),
          t.hearingImpaired ? el(0x55ab, uint(1, 1)) : new Uint8Array(0),
        ),
      ),
    ),
  ];
  const tracksEl = el(0x1654ae6b, concat(...entries));
  // Un SeekHead qui mène aux Cues, écrites à la fin comme le font les multiplexeurs.
  const seekHead = (cuesAt: number) => el(0x114d9b74, el(0x4dbb, concat(el(0x53ab, idBytes(0x1c53bb6b)), el(0x53ac, uint(cuesAt, 8)))));
  const headWithout = concat(seekHead(0), info, tracksEl);
  // Les positions sont relatives au début des données du Segment.
  const clusters: Uint8Array[] = [];
  const cuePoints: Uint8Array[] = [];
  let offset = headWithout.length;
  for (let s = 0; s < seconds; s++) {
    const timestamp = el(0xe7, uint(s * 1000));
    const children: Uint8Array[] = [timestamp, el(0xa3, blockPayload(1, 0, new Uint8Array(filler)))];
    const pending: { track: number; rel: number; duration: number }[] = [];
    let rel = timestamp.length + children[1].length;
    for (const t of tracks) {
      for (const [at, duration, line] of t.lines) {
        if (at !== s) continue;
        const relative = 250;
        const payload = blockPayload(t.number, relative, text(line));
        const block = t.blockGroup ? el(0xa0, concat(el(0xa1, payload), el(0x9b, uint(duration)))) : el(0xa3, payload);
        children.push(block);
        if (!t.unindexed) pending.push({ track: t.number, rel, duration });
        rel += block.length;
      }
    }
    const cluster = wideClusters ? elWide(0x1f43b675, concat(...children)) : el(0x1f43b675, concat(...children));
    // Vidéo : une entrée par grappe ; texte : une par réplique (CueTime = l'instant du bloc).
    cuePoints.push(el(0xbb, concat(el(0xb3, uint(s * 1000)), el(0xb7, concat(el(0xf7, uint(1, 1)), el(0xf1, uint(offset)))))));
    for (const p of pending) {
      cuePoints.push(
        el(0xbb, concat(el(0xb3, uint(s * 1000 + 250)), el(0xb7, concat(el(0xf7, uint(p.track, 1)), el(0xf1, uint(offset)), el(0xf0, uint(p.rel)), el(0xb2, uint(p.duration)))))),
      );
    }
    clusters.push(cluster);
    offset += cluster.length;
  }
  const cues = el(0x1c53bb6b, concat(...cuePoints));
  const head = concat(seekHead(offset), info, tracksEl);
  const segment = el(0x18538067, concat(head, ...clusters, cues));
  return concat(ebmlHeader, segment);
}
