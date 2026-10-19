import { avcCodecString, hevcCodecString } from "@/lib/webcodecs/codecConfig";

/**
 * Le MP4 fragmenté des téléchargements hors ligne (19/10/2026) — lu ici, et nulle part ailleurs.
 *
 * Jellyfin livre ses transcodages progressifs ainsi (`-movflags frag_keyframe+empty_moov+delay_moov`,
 * mesuré le 19/10) : `ftyp` + `moov` sans durée, puis des paires `moof` + `mdat` d'environ dix
 * secondes, image et son mêlés dans le même fragment. C'est déjà la forme qu'attend MediaSource :
 * le lecteur des téléchargements (`OfflinePlayerHost`) les lui confie tels quels, sans passer par le
 * remultiplexeur du lecteur en ligne — un chemin à part, voulu par Louis pour que la lecture en
 * ligne ne dépende en rien de celui-ci (`mp4Demux.ts`, lui, refuse toujours un MP4 fragmenté).
 *
 * Deux retouches, rien d'autre. Sur l'en-tête, l'entrée `hev1` devient `hvc1` (Safari refuse `hev1`
 * dans MediaSource ; Jellyfin range VPS, SPS et PPS dans le `hvcC`, ce qui est exactement ce que
 * `hvc1` exige — vérifié, et refusé sinon). Sur chaque fragment, l'adresse absolue que FFmpeg écrit
 * dans `tfhd` (`base-data-offset`, la position du `moof` dans le fichier) devient « relative au
 * moof » (`default-base-is-moof`) : Chrome refuse la première dans MediaSource (« TFHD
 * base-data-offset not allowed by MSE », relevé au premier essai réel le 19/10/2026), et les deux
 * désignent les mêmes octets — `normalizeFragment`.
 */

export interface Fmp4Track {
  id: number;
  kind: "video" | "audio";
  timescale: number;
  /** Le paramètre `codecs` de MediaSource : `hvc1.1.6.L93.90`, `avc1.64001f`, `mp4a.40.2`. */
  codec: string;
}

export interface Fmp4Init {
  /** L'en-tête à confier à MediaSource (`ftyp` + `moov`, retouché). */
  bytes: Uint8Array;
  /** Où commence le premier fragment dans le fichier. */
  end: number;
  tracks: Fmp4Track[];
  /** Le type MIME complet, image et son ensemble — un seul SourceBuffer, comme le fichier. */
  mime: string;
}

export interface Fmp4Fragment {
  /** Début du `moof` dans le fichier. */
  offset: number;
  /** `moof` + `mdat`. */
  size: number;
  /** L'instant de la première image du fragment, en secondes (`tfdt` de la piste image). */
  time: number;
}

const ascii = (b: Uint8Array, at: number) => String.fromCharCode(b[at], b[at + 1], b[at + 2], b[at + 3]);
const u32 = (b: Uint8Array, at: number) => ((b[at] << 24) | (b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]) >>> 0;
const u64 = (b: Uint8Array, at: number) => u32(b, at) * 2 ** 32 + u32(b, at + 4);

interface Box {
  type: string;
  start: number;
  /** Début du contenu, après l'en-tête. */
  body: number;
  end: number;
}

function boxAt(b: Uint8Array, at: number, limit: number): Box | null {
  if (at + 8 > limit) return null;
  let size = u32(b, at);
  let body = at + 8;
  if (size === 1) {
    if (at + 16 > limit) return null;
    size = u64(b, at + 8);
    body = at + 16;
  } else if (size === 0) {
    size = limit - at;
  }
  if (size < body - at) return null;
  return { type: ascii(b, at + 4), start: at, body, end: at + size };
}

function children(b: Uint8Array, from: number, to: number): Box[] {
  const out: Box[] = [];
  let at = from;
  while (at < to) {
    const box = boxAt(b, at, to);
    if (!box || box.end > to) break;
    out.push(box);
    at = box.end;
  }
  return out;
}

const child = (b: Uint8Array, parent: Box, type: string) => children(b, parent.body, parent.end).find((x) => x.type === type) ?? null;

function path(b: Uint8Array, from: Box, types: string[]): Box | null {
  let at: Box | null = from;
  for (const type of types) {
    if (!at) return null;
    at = child(b, at, type);
  }
  return at;
}

/** Le profil AAC d'après l'`esds` (`mp4a.40.<objet audio>`), AAC-LC à défaut. */
function aacCodec(b: Uint8Array, esds: Box | null): string {
  if (!esds) return "mp4a.40.2";
  // Descripteurs MPEG-4 : on cherche le DecoderSpecificInfo (tag 5), dont les 5 premiers bits
  // portent l'objet audio. Les longueurs sont codées sur 1 à 4 octets de 7 bits.
  let at = esds.body + 4;
  while (at < esds.end - 2) {
    const tag = b[at];
    let len = 0;
    let p = at + 1;
    for (let i = 0; i < 4 && p < esds.end; i++) {
      const byte = b[p++];
      len = (len << 7) | (byte & 0x7f);
      if (!(byte & 0x80)) break;
    }
    if (tag === 0x03) at = p + 3; // ES_Descriptor : ES_ID (2) + drapeaux (1), puis ses enfants.
    else if (tag === 0x04) at = p + 13; // DecoderConfigDescriptor : 13 octets fixes, puis ses enfants.
    else if (tag === 0x05) {
      const object = b[p] >> 3;
      return `mp4a.40.${object || 2}`;
    } else at = p + len;
  }
  return "mp4a.40.2";
}

/**
 * L'en-tête, lu sur les premiers octets du fichier (`ftyp` + `moov` ; le premier `moof` peut suivre).
 * `null` tant qu'il n'est pas entier — un téléchargement qui commence —, une erreur s'il est illisible.
 */
export function parseInit(source: Uint8Array): Fmp4Init | null {
  const top: Box[] = [];
  let at = 0;
  let moov: Box | null = null;
  while (at < source.length) {
    const box = boxAt(source, at, Number.MAX_SAFE_INTEGER);
    if (!box) return null;
    if (box.type === "moof" || box.type === "mdat") break;
    if (box.end > source.length) return null;
    top.push(box);
    if (box.type === "moov") moov = box;
    at = box.end;
  }
  if (!moov) {
    if (at >= source.length) return null;
    throw new Error("MP4 fragmenté : pas de moov avant le premier fragment");
  }
  const end = at;
  const bytes = source.slice(0, end);
  const tracks: Fmp4Track[] = [];
  for (const trak of children(bytes, moov.body, moov.end).filter((x) => x.type === "trak")) {
    const tkhd = child(bytes, trak, "tkhd");
    const mdhd = path(bytes, trak, ["mdia", "mdhd"]);
    const hdlr = path(bytes, trak, ["mdia", "hdlr"]);
    const stsd = path(bytes, trak, ["mdia", "minf", "stbl", "stsd"]);
    if (!tkhd || !mdhd || !hdlr || !stsd) continue;
    const id = bytes[tkhd.body] === 1 ? u32(bytes, tkhd.body + 4 + 16) : u32(bytes, tkhd.body + 4 + 8);
    const timescale = bytes[mdhd.body] === 1 ? u32(bytes, mdhd.body + 4 + 16) : u32(bytes, mdhd.body + 4 + 8);
    const handler = ascii(bytes, hdlr.body + 8);
    const entry = boxAt(bytes, stsd.body + 8, stsd.end);
    if (!entry) continue;
    if (handler === "vide") {
      // Entrée visuelle : 78 octets fixes avant ses enfants.
      const config = children(bytes, entry.body + 78, entry.end);
      let codec: string | null = null;
      if (entry.type === "hev1" || entry.type === "hvc1") {
        const hvcC = config.find((x) => x.type === "hvcC");
        if (!hvcC) throw new Error("MP4 fragmenté : HEVC sans hvcC");
        // `hvc1` exige les jeux de paramètres dans le hvcC : on ne renomme qu'à cette condition.
        if (entry.type === "hev1") {
          const arrays = bytes[hvcC.body + 22];
          if (!arrays) throw new Error("MP4 fragmenté : hev1 sans jeux de paramètres dans le hvcC");
          bytes.set([0x68, 0x76, 0x63, 0x31], entry.start + 4); // "hvc1"
        }
        codec = hevcCodecString(bytes.subarray(hvcC.body, hvcC.end));
      } else if (entry.type === "avc1" || entry.type === "avc3") {
        const avcC = config.find((x) => x.type === "avcC");
        codec = avcC ? avcCodecString(bytes.subarray(avcC.body, avcC.end)) : null;
      }
      if (!codec) throw new Error(`MP4 fragmenté : image ${entry.type} non prise en charge`);
      tracks.push({ id, kind: "video", timescale, codec });
    } else if (handler === "soun") {
      // Entrée sonore : 28 octets fixes avant ses enfants.
      if (entry.type !== "mp4a") throw new Error(`MP4 fragmenté : son ${entry.type} non pris en charge`);
      tracks.push({ id, kind: "audio", timescale, codec: aacCodec(bytes, children(bytes, entry.body + 28, entry.end).find((x) => x.type === "esds") ?? null) });
    }
  }
  const video = tracks.find((t) => t.kind === "video");
  if (!video) throw new Error("MP4 fragmenté : aucune piste image");
  const mime = `video/mp4; codecs="${tracks.map((t) => t.codec).join(",")}"`;
  return { bytes, end, tracks, mime };
}

/**
 * L'index des fragments, construit au fil du fichier : on ne lit que les en-têtes des boîtes et
 * les `moof` (quelques Ko par dix secondes de film). `read` rend les octets demandés, ou moins
 * s'ils n'existent pas encore — un fichier en cours de téléchargement. Reprend à `from` et rend où
 * il s'est arrêté : le premier fragment incomplet, ou la fin.
 */
export async function scanFragments(
  read: (offset: number, length: number) => Promise<Uint8Array>,
  from: number,
  available: number,
  videoTrack: Fmp4Track
): Promise<{ fragments: Fmp4Fragment[]; next: number }> {
  const fragments: Fmp4Fragment[] = [];
  let at = from;
  while (at + 16 <= available) {
    const head = await read(at, 16);
    const moof = boxAt(head, 0, head.length);
    if (!moof) break;
    const moofSize = moof.end;
    if (moof.type !== "moof") {
      // Une boîte qui n'est pas un fragment (`mfra` à la fin, `free`…) : sautée.
      if (at + moofSize > available) break;
      at += moofSize;
      continue;
    }
    if (at + moofSize + 16 > available) break;
    const mdatHead = await read(at + moofSize, 16);
    const mdat = boxAt(mdatHead, 0, mdatHead.length);
    if (!mdat || mdat.type !== "mdat") throw new Error(`MP4 fragmenté : moof sans mdat à ${at}`);
    const size = moofSize + mdat.end;
    if (at + size > available) break;
    const body = await read(at, moofSize);
    let time: number | null = null;
    for (const traf of children(body, 8, moofSize).filter((x) => x.type === "traf")) {
      const tfhd = child(body, traf, "tfhd");
      const tfdt = child(body, traf, "tfdt");
      if (!tfhd || !tfdt || u32(body, tfhd.body + 4) !== videoTrack.id) continue;
      const decodeTime = body[tfdt.body] === 1 ? u64(body, tfdt.body + 4) : u32(body, tfdt.body + 4);
      time = decodeTime / videoTrack.timescale;
    }
    if (time !== null) fragments.push({ offset: at, size, time });
    at += size;
  }
  return { fragments, next: at };
}

/** Le fragment où commencer pour montrer `seconds` : le dernier qui commence avant. */
export function fragmentIndexAt(fragments: readonly Fmp4Fragment[], seconds: number): number {
  let lo = 0;
  let hi = fragments.length - 1;
  if (hi < 0) return -1;
  if (seconds <= fragments[0].time) return 0;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (fragments[mid].time <= seconds) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/**
 * Un fragment (`moof` + `mdat`) tel que MediaSource l'accepte partout : chaque `tfhd` qui porte une
 * adresse absolue (`base-data-offset`, drapeau 0x1) la perd au profit de `default-base-is-moof`
 * (0x20000). FFmpeg y écrit la position du `moof` lui-même, et ses `trun` comptent leurs données à
 * partir de là : retirer huit octets par piste rapproche les données d'autant, et chaque `data_offset`
 * diminue du total retiré. Un fragment déjà relatif est rendu tel quel ; une adresse qui ne serait pas
 * celle du `moof` est refusée plutôt que devinée.
 */
export function normalizeFragment(fragment: Uint8Array, offsetInFile: number): Uint8Array {
  const moof = boxAt(fragment, 0, fragment.length);
  if (!moof || moof.type !== "moof") throw new Error("MP4 fragmenté : un fragment ne commence pas par moof");
  const trafs = children(fragment, moof.body, moof.end).filter((x) => x.type === "traf");
  const isAbsolute = (traf: Box) => {
    const tfhd = child(fragment, traf, "tfhd");
    return Boolean(tfhd && fragment[tfhd.body + 3] & 0x01);
  };
  const removed = trafs.filter(isAbsolute).length * 8;
  if (removed === 0) return fragment;

  // Les huit octets de chaque adresse sautés à la copie ; le reste, octet pour octet.
  const cuts: number[] = [];
  for (const traf of trafs) {
    if (!isAbsolute(traf)) continue;
    const tfhd = child(fragment, traf, "tfhd")!;
    const base = u64(fragment, tfhd.body + 8);
    if (base !== offsetInFile) throw new Error(`MP4 fragmenté : adresse de base ${base} hors du moof (${offsetInFile})`);
    cuts.push(tfhd.body + 8);
  }
  const out = new Uint8Array(fragment.length - removed);
  let read = 0;
  let write = 0;
  for (const cut of cuts) {
    out.set(fragment.subarray(read, cut), write);
    write += cut - read;
    read = cut + 8;
  }
  out.set(fragment.subarray(read), write);

  // Où une position d'origine se trouve après les coupes qui la précèdent.
  const moved = (original: number) => original - 8 * cuts.filter((cut) => cut < original).length;
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  view.setUint32(0, moof.end - removed);
  for (const traf of trafs) {
    const tfhd = child(fragment, traf, "tfhd")!;
    if (isAbsolute(traf)) {
      view.setUint32(moved(traf.start), traf.end - traf.start - 8);
      view.setUint32(moved(tfhd.start), tfhd.end - tfhd.start - 8);
      const flags = view.getUint32(moved(tfhd.body));
      view.setUint32(moved(tfhd.body), (flags & ~0x01) | 0x020000);
    }
    // Les données sont désormais comptées depuis le moof raccourci : chaque décalage perd ce qui a été retiré.
    for (const trun of children(fragment, traf.body, traf.end).filter((x) => x.type === "trun")) {
      if (!(fragment[trun.body + 3] & 0x01)) continue;
      const position = moved(trun.body + 8);
      view.setInt32(position, view.getInt32(position) - removed);
    }
  }
  return out;
}
