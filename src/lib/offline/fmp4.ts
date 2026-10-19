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
 *
 * Une exception : le fragment trop long (`SPLIT_S`, `SPLIT_BYTES`), découpé en morceaux — voir
 * `Fmp4Reader`. Un fragment ordinaire (HEVC, ~10 s) passe toujours par `normalizeFragment`, octet
 * pour octet comme avant.
 */

export interface Fmp4Track {
  id: number;
  kind: "video" | "audio";
  timescale: number;
  /** Le paramètre `codecs` de MediaSource : `hvc1.1.6.L93.90`, `avc1.64001f`, `mp4a.40.2`. */
  codec: string;
  /** Image H.264 seulement : la taille du préfixe de longueur de chaque NAL (`avcC`), pour lire les images. */
  nalLengthSize?: number;
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
  /**
   * Un morceau d'un fragment trop long (`planPieces`) : `offset` et `size` restent ceux du fragment
   * entier, `time` est l'instant de décodage de sa première image, et ses images sont, dans l'ordre
   * de décodage de la piste image, `first` … `first + count − 1`. Le reste — le son, les octets — se
   * déduit du `moof` relu (`Fmp4Reader`) : l'index n'en garde que ces trois nombres.
   */
  piece?: { moofSize: number; first: number; count: number };
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
      let nalLengthSize: number | undefined;
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
        if (avcC && avcC.end - avcC.body > 4) nalLengthSize = (bytes[avcC.body + 4] & 0x03) + 1;
      }
      if (!codec) throw new Error(`MP4 fragmenté : image ${entry.type} non prise en charge`);
      tracks.push(nalLengthSize ? { id, kind: "video", timescale, codec, nalLengthSize } : { id, kind: "video", timescale, codec });
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
    if (time !== null) {
      // Le fragment trop long est rangé en morceaux ; le `moof` est déjà lu, le découpage n'en
      // demande pas plus. Les autres restent une entrée chacun, comme avant.
      const video = parseMoof(body, at).find((t) => t.trackId === videoTrack.id);
      const span = video ? video.times[video.count] - video.times[0] : 0;
      if (video && video.count > 1 && (size > SPLIT_BYTES || span > SPLIT_S * videoTrack.timescale)) {
        for (const [first, count] of planPieces(video, videoTrack.timescale)) {
          fragments.push({ offset: at, size, time: video.times[first] / videoTrack.timescale, piece: { moofSize, first, count } });
        }
      } else fragments.push({ offset: at, size, time });
    }
    at += size;
  }
  return { fragments, next: at };
}

/**
 * Le fragment (ou le morceau) où commencer pour montrer `seconds` : le dernier qui commence avant.
 * Un morceau ne commence pas forcément sur une image où un décodeur peut partir : c'est
 * `Fmp4Reader.fragment(…, from)` qui le dit, et le moteur recule d'un morceau si besoin.
 */
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

/*
 * Le fragment trop long (19/10/2026).
 *
 * `frag_keyframe` ne coupe un fragment que sur un échantillon que FFmpeg marque « sync » — en
 * H.264, une IDR. Quand Jellyfin demande du H.264 (un navigateur sans HEVC : Firefox, Chrome sans
 * décodeur HEVC), il lance `h264_qsv … -force_key_frames "expr:gte(t,n_forced*5)"`, et les images
 * forcées toutes les cinq secondes n'en sont pas. Mesuré le 19/10 sur les deux préparations H.264
 * de l'appareil (*Duel*, *The Garden of Words* : 782 fragments) : chaque image forcée est une
 * tranche non IDR (NAL de type 1, `slice_type` I) précédée de SPS, PPS et d'un SEI de minutage
 * (type 1) — **ni IDR, ni SEI de point de reprise (type 6)** —, et son `trun` la dit dépendante
 * (`sample_flags` 0x01010000, comme une P ou une B). Seule l'IDR du début de groupe (0x02000000,
 * SPS + PPS + SEI 0 et 1 + NAL 5) est marquée. Ce sont donc les IDR qui font la taille d'un
 * fragment : QSV en met une toutes les 250 images (10,4 s) sur ces deux films, un fragment sur
 * trente en a sauté une (20,9 s, 5,5 Mo) ; un groupe plus long — relevé une fois à ~450 s pour
 * ~110 Mo — fait un fragment d'autant. `fixtures/offline/generate.sh` reproduit cette forme
 * exacte (QSV nourri d'images *décodées* : une image sortie d'un filtre `lavfi` porte le drapeau
 * « clé », et QSV fait alors une IDR de chaque image forcée, ce qui masque le défaut).
 *
 * Deux conséquences : le moteur aurait confié au navigateur sept minutes d'un coup (WebKit plafonne
 * un SourceBuffer à ~105 Mo, Chromium à 150 Mio), et un saut ne pouvait repartir que du début d'un
 * fragment — des minutes avant la position voulue.
 *
 * D'où les morceaux : un fragment de plus de `SPLIT_S` secondes ou `SPLIT_BYTES` octets est rangé,
 * dans l'index, en morceaux d'environ `PIECE_S` secondes (`planPieces`, d'après le seul `moof`),
 * et chaque morceau est réécrit, à la lecture, en un fragment complet à lui (`moof` avec `mfhd`,
 * `traf`/`tfhd`/`tfdt`/`trun` par piste, puis `mdat`), le son réparti selon l'instant de décodage.
 * Rien n'est lu en entier : le `moof` (quelques centaines de Ko pour sept minutes), puis seulement
 * les plages du `mdat` du morceau.
 *
 * Les images forcées deviennent des points d'entrée. Mesuré le 19/10 : 20 images forcées tirées au
 * hasard dans les deux films, décodées par le FFmpeg de Jellyfin en partant d'elles, rendent des
 * images identiques bit à bit à celles d'un décodage parti de l'IDR — y compris les B qui les
 * suivent dans l'ordre de décodage et s'affichent avant elles. QSV ne fait référence à rien
 * d'antérieur : ce sont des points de reprise exacts que l'encodeur ne déclare pas. On les déclare
 * donc : marquées « sync » dans le `trun` réécrit, et précédées d'un SEI de point de reprise
 * (`recovery_frame_cnt` 0, `exact_match` 1). Le SEI n'est pas décoratif : le décodeur matériel de
 * Chromium (`h264_decoder.cc`) saute, après une remise à zéro, toute tranche non IDR qui n'est pas
 * annoncée par un tel SEI — sans lui, un saut aurait figé l'image jusqu'à l'IDR suivante.
 *
 * Limite assumée : la propreté de ces images est mesurée sur QSV, pas garantie par le flux. Une
 * image I non IDR d'un autre encodeur dont les suivantes se référeraient à d'avant donnerait, au
 * pire, quelques images abîmées après un saut, jusqu'à l'IDR suivante — jamais en lecture continue,
 * où toutes les références sont là. Safari n'est pas concerné : il lit le HEVC et ne reçoit jamais
 * ce flux. Un morceau HEVC (un fragment HEVC trop long, jamais vu) n'a pour points d'entrée que
 * ses échantillons marqués « sync ».
 */

/** Au-delà, un fragment est découpé ; en deçà — les fragments HEVC de ~10 s —, il passe tel quel. */
const SPLIT_S = 12;
const SPLIT_BYTES = 8 * 1024 * 1024;
/** La taille visée d'un morceau : un groupe d'images forcées, et quelques Mo au plus. */
const PIECE_S = 5;
const PIECE_BYTES = 4 * 1024 * 1024;

const i32 = (b: Uint8Array, at: number) => (b[at] << 24) | (b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3];

/** `sample_flags` d'une image où l'on peut commencer à décoder : ne dépend de rien, pas « non sync ». */
const SYNC_FLAGS = 0x02000000;
const isSync = (flags: number) => (flags & 0x00010000) === 0;

/** Les échantillons d'une piste dans un `moof`, à plat (tous ses `trun` bout à bout). */
interface TrafTable {
  trackId: number;
  descriptionIndex: number | null;
  trunVersion: number;
  count: number;
  /** L'instant de décodage de chaque échantillon puis celui de la fin (`count + 1` valeurs), en unités de la piste. */
  times: Float64Array;
  sizes: Uint32Array;
  flags: Uint32Array;
  ctos: Int32Array;
  /** La position de chaque échantillon dans le fichier. */
  offsets: Float64Array;
}

function parseMoof(b: Uint8Array, moofOffset: number): TrafTable[] {
  const moof = boxAt(b, 0, b.length);
  if (!moof || moof.type !== "moof") throw new Error(`MP4 fragmenté : pas de moof à ${moofOffset}`);
  const out: TrafTable[] = [];
  // ISO 14496-12 § 8.8.7 : sans adresse explicite ni `default-base-is-moof`, le premier traf compte
  // depuis le moof, chacun des suivants depuis la fin des données du précédent.
  let previousEnd = moofOffset;
  let firstTraf = true;
  for (const traf of children(b, moof.body, moof.end).filter((x) => x.type === "traf")) {
    const tfhd = child(b, traf, "tfhd");
    if (!tfhd) continue;
    const tf = u32(b, tfhd.body) & 0xffffff;
    let p = tfhd.body + 8;
    const trackId = u32(b, tfhd.body + 4);
    let base = firstTraf || tf & 0x020000 ? moofOffset : previousEnd;
    if (tf & 0x01) {
      base = u64(b, p);
      p += 8;
    }
    let descriptionIndex: number | null = null;
    if (tf & 0x02) {
      descriptionIndex = u32(b, p);
      p += 4;
    }
    let dDuration = 0;
    let dSize = 0;
    let dFlags = 0;
    if (tf & 0x08) {
      dDuration = u32(b, p);
      p += 4;
    }
    if (tf & 0x10) {
      dSize = u32(b, p);
      p += 4;
    }
    if (tf & 0x20) dFlags = u32(b, p);
    const tfdt = child(b, traf, "tfdt");
    let time = tfdt ? (b[tfdt.body] === 1 ? u64(b, tfdt.body + 4) : u32(b, tfdt.body + 4)) : 0;
    const truns = children(b, traf.body, traf.end).filter((x) => x.type === "trun");
    const count = truns.reduce((n, trun) => n + u32(b, trun.body + 4), 0);
    const table: TrafTable = {
      trackId,
      descriptionIndex,
      trunVersion: truns.length ? b[truns[0].body] : 0,
      count,
      times: new Float64Array(count + 1),
      sizes: new Uint32Array(count),
      flags: new Uint32Array(count),
      ctos: new Int32Array(count),
      offsets: new Float64Array(count),
    };
    let k = 0;
    let dataAt = base;
    for (const trun of truns) {
      const fl = u32(b, trun.body) & 0xffffff;
      const n = u32(b, trun.body + 4);
      let q = trun.body + 8;
      if (fl & 0x01) {
        dataAt = base + i32(b, q);
        q += 4;
      }
      let firstFlags: number | null = null;
      if (fl & 0x04) {
        firstFlags = u32(b, q);
        q += 4;
      }
      for (let i = 0; i < n; i++, k++) {
        let duration = dDuration;
        let size = dSize;
        let flags = i === 0 && firstFlags !== null ? firstFlags : dFlags;
        let cto = 0;
        if (fl & 0x100) {
          duration = u32(b, q);
          q += 4;
        }
        if (fl & 0x200) {
          size = u32(b, q);
          q += 4;
        }
        if (fl & 0x400) {
          flags = u32(b, q);
          q += 4;
        }
        if (fl & 0x800) {
          cto = i32(b, q);
          q += 4;
        }
        table.times[k] = time;
        table.sizes[k] = size;
        table.flags[k] = flags;
        table.ctos[k] = cto;
        table.offsets[k] = dataAt;
        time += duration;
        dataAt += size;
      }
    }
    table.times[count] = time;
    previousEnd = dataAt;
    firstTraf = false;
    out.push(table);
  }
  return out;
}

/**
 * Où couper : un nouveau morceau dès que le courant atteint `PIECE_S` secondes ou dépasserait
 * `PIECE_BYTES`. Sur le seul `moof` — savoir où sont les images forcées demanderait de lire le
 * `mdat` entier à l'indexation. Couper au milieu d'un groupe ne gêne pas la lecture continue
 * (MediaSource n'exige une image « sync » qu'après une remise à zéro) ; c'est `Fmp4Reader` qui
 * trouve, au saut, l'image où repartir. Rend des paires [première image, nombre d'images].
 */
function planPieces(video: TrafTable, timescale: number): Array<[number, number]> {
  const pieces: Array<[number, number]> = [];
  let start = 0;
  let bytes = 0;
  for (let i = 0; i < video.count; i++) {
    if (i > start && (video.times[i] - video.times[start] >= PIECE_S * timescale || bytes + video.sizes[i] > PIECE_BYTES)) {
      pieces.push([start, i - start]);
      start = i;
      bytes = 0;
    }
    bytes += video.sizes[i];
  }
  pieces.push([start, video.count - start]);
  return pieces;
}

/** Le RBSP des premiers octets d'un NAL (octets d'échappement 0x03 retirés) — assez pour un en-tête. */
function rbsp(unit: Uint8Array, max: number): Uint8Array {
  const out: number[] = [];
  let zeros = 0;
  for (let i = 0; i < unit.length && out.length < max; i++) {
    const byte = unit[i];
    if (zeros >= 2 && byte === 3) {
      zeros = 0;
      continue;
    }
    out.push(byte);
    zeros = byte === 0 ? zeros + 1 : 0;
  }
  return Uint8Array.from(out);
}

/** Un entier Exp-Golomb non signé, lu à partir du bit `state.bit` ; `null` au-delà des octets. */
function readUe(bytes: Uint8Array, state: { bit: number }): number | null {
  const next = () => {
    if (state.bit >= bytes.length * 8) return null;
    const value = (bytes[state.bit >> 3] >> (7 - (state.bit & 7))) & 1;
    state.bit += 1;
    return value;
  };
  let zeros = 0;
  for (;;) {
    const bit = next();
    if (bit === null || zeros > 31) return null;
    if (bit) break;
    zeros += 1;
  }
  let value = 0;
  for (let i = 0; i < zeros; i++) {
    const bit = next();
    if (bit === null) return null;
    value = value * 2 + bit;
  }
  return 2 ** zeros - 1 + value;
}

/** Le SEI (RBSP, sans l'octet d'en-tête du NAL) porte-t-il un point de reprise (message 6) ? */
function hasRecoveryPoint(sei: Uint8Array): boolean {
  let at = 0;
  while (at < sei.length && sei[at] !== 0x80) {
    let type = 0;
    while (at < sei.length && sei[at] === 0xff) {
      type += 255;
      at += 1;
    }
    type += sei[at++] ?? 0;
    let size = 0;
    while (at < sei.length && sei[at] === 0xff) {
      size += 255;
      at += 1;
    }
    size += sei[at++] ?? 0;
    if (type === 6) return true;
    at += size;
  }
  return false;
}

/**
 * Une image H.264 « I forcée » : sa première tranche est non IDR (type 1) et intra (`slice_type`
 * 2 ou 7). Rend où commence le NAL de cette tranche (préfixe de longueur compris), et si un SEI de
 * point de reprise la précède déjà ; `null` pour toute autre image, IDR comprise (déjà « sync »).
 */
function forcedIntra(sample: Uint8Array, lengthSize: number): { at: number; announced: boolean } | null {
  let announced = false;
  for (let at = 0; at + lengthSize < sample.length; ) {
    let length = 0;
    for (let i = 0; i < lengthSize; i++) length = length * 256 + sample[at + i];
    const start = at + lengthSize;
    const end = start + length;
    if (length <= 0 || end > sample.length) return null;
    const type = sample[start] & 0x1f;
    if (type === 6 && hasRecoveryPoint(rbsp(sample.subarray(start + 1, end), 256))) announced = true;
    if (type === 5) return null;
    if (type === 1) {
      const header = rbsp(sample.subarray(start + 1, end), 16);
      const state = { bit: 0 };
      if (readUe(header, state) === null) return null; // first_mb_in_slice
      const sliceType = readUe(header, state);
      return sliceType !== null && sliceType % 5 === 2 ? { at, announced } : null;
    }
    at = end;
  }
  return null;
}

/**
 * Le SEI de point de reprise glissé devant une image forcée : NAL 6, message 6 d'un octet —
 * `recovery_frame_cnt` = 0 (ue « 1 »), `exact_match_flag` = 1, `broken_link_flag` = 0,
 * `changing_slice_group_idc` = 0, puis l'alignement (un 1 et des 0) : 0xC4 ; enfin l'arrêt RBSP 0x80.
 */
const RECOVERY_SEI = Uint8Array.of(0x06, 0x06, 0x01, 0xc4, 0x80);

function withRecoverySei(sample: Uint8Array, at: number, lengthSize: number): Uint8Array {
  const out = new Uint8Array(sample.length + lengthSize + RECOVERY_SEI.length);
  out.set(sample.subarray(0, at), 0);
  let length = RECOVERY_SEI.length;
  for (let i = lengthSize - 1; i >= 0; i--) {
    out[at + i] = length & 0xff;
    length >>>= 8;
  }
  out.set(RECOVERY_SEI, at + lengthSize);
  out.set(sample.subarray(at), at + lengthSize + RECOVERY_SEI.length);
  return out;
}

interface PieceTrack {
  table: TrafTable;
  from: number;
  to: number;
  samples: Uint8Array[];
  flags: number[];
}

/** Un fragment complet pour les échantillons choisis : `moof` (mfhd recopié, une traf par piste) + `mdat`. */
function writePiece(mfhd: Uint8Array, tracks: PieceTrack[]): Uint8Array {
  const layout = tracks
    .filter((t) => t.to > t.from)
    .map((t) => {
      const n = t.to - t.from;
      let hasCto = false;
      for (let i = t.from; i < t.to; i++) if (t.table.ctos[i] !== 0) hasCto = true;
      const tfhd = 16 + (t.table.descriptionIndex !== null ? 4 : 0);
      const trun = 20 + n * (hasCto ? 16 : 12);
      const data = t.samples.reduce((sum, s) => sum + s.length, 0);
      return { t, n, hasCto, tfhd, trun, traf: 8 + tfhd + 20 + trun, data };
    });
  const moofSize = 8 + mfhd.length + layout.reduce((sum, l) => sum + l.traf, 0);
  const dataSize = layout.reduce((sum, l) => sum + l.data, 0);
  const out = new Uint8Array(moofSize + 8 + dataSize);
  const view = new DataView(out.buffer);
  const box = (at: number, size: number, type: string) => {
    view.setUint32(at, size);
    for (let i = 0; i < 4; i++) out[at + 4 + i] = type.charCodeAt(i);
  };
  box(0, moofSize, "moof");
  out.set(mfhd, 8);
  let at = 8 + mfhd.length;
  let dataAt = moofSize + 8;
  for (const { t, n, hasCto, tfhd, trun, traf, data } of layout) {
    box(at, traf, "traf");
    let p = at + 8;
    // tfhd : relatif au moof (0x020000) — ce que Chrome exige —, l'entrée de description recopiée si elle était dite.
    box(p, tfhd, "tfhd");
    view.setUint32(p + 8, 0x020000 | (t.table.descriptionIndex !== null ? 0x02 : 0));
    view.setUint32(p + 12, t.table.trackId);
    if (t.table.descriptionIndex !== null) view.setUint32(p + 16, t.table.descriptionIndex);
    p += tfhd;
    box(p, 20, "tfdt");
    view.setUint32(p + 8, 0x01000000); // version 1 : 64 bits
    const baseTime = t.table.times[t.from];
    view.setUint32(p + 12, Math.floor(baseTime / 2 ** 32));
    view.setUint32(p + 16, baseTime % 2 ** 32);
    p += 20;
    // trun : tout explicite (durée, taille, drapeaux, décalage d'affichage s'il en est), sans valeur
    // par défaut à aller chercher dans un tfhd qui n'en porte plus. Même version que l'original : le
    // décalage d'affichage garde son sens (non signé en version 0, signé en 1), recopié tel quel.
    box(p, trun, "trun");
    view.setUint32(p + 8, ((t.table.trunVersion & 0xff) << 24) | 0x000701 | (hasCto ? 0x800 : 0));
    view.setUint32(p + 12, n);
    view.setInt32(p + 16, dataAt);
    p += 20;
    for (let i = 0; i < n; i++) {
      const k = t.from + i;
      view.setUint32(p, t.table.times[k + 1] - t.table.times[k]);
      view.setUint32(p + 4, t.samples[i].length);
      view.setUint32(p + 8, t.flags[i]);
      if (hasCto) view.setInt32(p + 12, t.table.ctos[k]);
      p += hasCto ? 16 : 12;
    }
    at += traf;
    dataAt += data;
  }
  box(moofSize, 8 + dataSize, "mdat");
  let write = moofSize + 8;
  for (const { t } of layout) {
    for (const sample of t.samples) {
      out.set(sample, write);
      write += sample.length;
    }
  }
  return out;
}

export type Fmp4ReadFn = (offset: number, length: number) => Promise<Uint8Array>;

/**
 * Rend, pour une entrée de l'index, les octets à confier au navigateur. Un fragment ordinaire :
 * lu en entier et `normalizeFragment`, exactement comme avant. Un morceau : réécrit en fragment à
 * part, à partir du `moof` relu (gardé pour le morceau suivant) et des seules plages de son `mdat`.
 *
 * `from` (en secondes) demande de commencer à la dernière image où un décodeur peut partir et qui
 * s'affiche au plus tard à cet instant — l'appel d'après un saut, ou d'une ouverture en cours de
 * film. `entry: false` dit que ce morceau n'en a aucune avant `from` : le moteur reprend alors au
 * morceau précédent, `from` infini (sa dernière image d'entrée). Le premier morceau d'un fragment
 * en a toujours une, son début (`frag_keyframe`). `null` : les octets ne sont pas encore sur
 * l'appareil.
 */
export class Fmp4Reader {
  private cached: { offset: number; tables: TrafTable[]; mfhd: Uint8Array } | null = null;
  private readonly video: Fmp4Track;

  constructor(
    private readonly read: Fmp4ReadFn,
    private readonly tracks: readonly Fmp4Track[]
  ) {
    const video = tracks.find((t) => t.kind === "video");
    if (!video) throw new Error("MP4 fragmenté : aucune piste image");
    this.video = video;
  }

  async fragment(fragment: Fmp4Fragment, from?: number): Promise<{ bytes: Uint8Array; entry: boolean } | null> {
    if (!fragment.piece) {
      const bytes = await this.read(fragment.offset, fragment.size);
      if (bytes.length < fragment.size) return null;
      return { bytes: normalizeFragment(bytes, fragment.offset), entry: true };
    }
    const { moofSize, first, count } = fragment.piece;
    const moof = await this.moof(fragment.offset, moofSize);
    if (!moof) return null;
    const video = moof.tables.find((t) => t.trackId === this.video.id);
    if (!video || first + count > video.count) throw new Error(`MP4 fragmenté : morceau hors du fragment à ${fragment.offset}`);
    const end = first + count;
    const videoSamples = await this.samples(video, first, end);
    if (!videoSamples) return null;

    // Les images où l'on peut partir : marquées « sync » par FFmpeg, ou I forcées (voir plus haut).
    const lengthSize = this.video.nalLengthSize;
    const forced = new Map<number, { at: number; announced: boolean }>();
    if (lengthSize) {
      for (let i = first; i < end; i++) {
        if (isSync(video.flags[i])) continue;
        const intra = forcedIntra(videoSamples[i - first], lengthSize);
        if (intra) forced.set(i, intra);
      }
    }
    let start = first;
    if (from !== undefined) {
      let chosen = -1;
      for (let i = first; i < end; i++) {
        if (!(isSync(video.flags[i]) || forced.has(i))) continue;
        if ((video.times[i] + video.ctos[i]) / this.video.timescale <= from) chosen = i;
      }
      // Le début d'un fragment est son entrée, même s'il s'affiche un rien après `from` (le
      // décalage d'affichage de la première image) : rien ne le précède dans ce fragment.
      if (chosen < 0 && first === 0) chosen = 0;
      if (chosen < 0) return { bytes: new Uint8Array(0), entry: false };
      start = chosen;
    }

    const pieceTracks: PieceTrack[] = [];
    for (const table of moof.tables) {
      if (table === video) {
        const samples: Uint8Array[] = [];
        const flags: number[] = [];
        for (let i = start; i < end; i++) {
          const intra = forced.get(i);
          const sample = videoSamples[i - first];
          samples.push(intra && !intra.announced ? withRecoverySei(sample, intra.at, lengthSize!) : sample);
          flags.push(intra ? SYNC_FLAGS : video.flags[i]);
        }
        pieceTracks.push({ table, from: start, to: end, samples, flags });
        continue;
      }
      // Les autres pistes (le son) : les échantillons dont l'instant de décodage tombe entre la
      // première image du morceau et celle du suivant — tout ce qui précède pour le premier morceau
      // d'un fragment, tout ce qui suit pour le dernier : rien ne se perd ni ne se répète.
      const track = this.tracks.find((t) => t.id === table.trackId);
      if (!track) continue;
      const scaled = (j: number) => table.times[j] * this.video.timescale;
      const lower = start === 0 ? -Infinity : video.times[start] * track.timescale;
      const upper = end === video.count ? Infinity : video.times[end] * track.timescale;
      let a = 0;
      while (a < table.count && scaled(a) < lower) a++;
      let b = a;
      while (b < table.count && scaled(b) < upper) b++;
      const samples = await this.samples(table, a, b);
      if (!samples) return null;
      pieceTracks.push({ table, from: a, to: b, samples, flags: Array.from(table.flags.subarray(a, b)) });
    }
    return { bytes: writePiece(moof.mfhd, pieceTracks), entry: true };
  }

  private async moof(offset: number, size: number): Promise<{ tables: TrafTable[]; mfhd: Uint8Array } | null> {
    if (this.cached?.offset === offset) return this.cached;
    const bytes = await this.read(offset, size);
    if (bytes.length < size) return null;
    const box = boxAt(bytes, 0, bytes.length);
    if (!box || box.type !== "moof") throw new Error(`MP4 fragmenté : pas de moof à ${offset}`);
    const mfhd = child(bytes, box, "mfhd");
    this.cached = { offset, tables: parseMoof(bytes, offset), mfhd: mfhd ? bytes.slice(mfhd.start, mfhd.end) : new Uint8Array(0) };
    return this.cached;
  }

  /** Les octets des échantillons `from` … `to − 1`, lus par plages contiguës du fichier. */
  private async samples(table: TrafTable, from: number, to: number): Promise<Uint8Array[] | null> {
    const out: Uint8Array[] = [];
    let i = from;
    while (i < to) {
      let j = i + 1;
      while (j < to && table.offsets[j] === table.offsets[j - 1] + table.sizes[j - 1]) j++;
      const length = table.offsets[j - 1] + table.sizes[j - 1] - table.offsets[i];
      const bytes = await this.read(table.offsets[i], length);
      if (bytes.length < length) return null;
      for (let k = i; k < j; k++) {
        const at = table.offsets[k] - table.offsets[i];
        out.push(bytes.subarray(at, at + table.sizes[k]));
      }
      i = j;
    }
    return out;
  }
}
