// Les modes d'essai de démarrage de Lumen serveur (étape 3e de docs/remux-serveur/, DECISIONS §160).
//
// Pourquoi un fichier à part : ce sont des essais de la page de banc `/lumen-test`, pas la règle. Sans eux, rien ne
// change d'un octet — ni les listes, ni les segments, ni les adresses — et le reste du moteur (`format.ts`,
// `segment.ts`, `playlists.ts`) n'en sait rien : ces fonctions transforment ce qu'il produit déjà. Un essai qui
// ne paie pas part avec ce fichier, sans rien démêler ailleurs.
//
// Deux sortes d'essais, selon ce qu'ils changent :
//
// - **Le son par défaut multiplexé dans les segments vidéo** (levier a, `m1`) change des octets servis et des
//   noms : il est **porté par la version de l'adresse** (`2m1-…`, `muxVersion`), comme une découpe d'essai
//   (§157) — les URI relatives des listes en héritent, et rien (cache du navigateur, segments partagés) ne mélange
//   la règle et l'essai. Les noms multiplexés (`vm3.m3u8`, `init-vm3.mp4`, `vm3/12.m4s` — vidéo + piste 3)
//   n'existent que sous une telle version.
// - **Ce que dit la seule liste maître** — `EXT-X-START` (levier c, `?start=`) et le BANDWIDTH annoncé
//   (levier d, `?bw=moyen`) : ni frontière ni octet de segment ne bouge (la règle de `LUMEN_FORMAT_VERSION`,
//   format.ts), la liste maître n'est jamais gardée (`private, no-cache`) — une requête de la liste maître suffit.
//
// Ce que dit la spécification, vérifié le 17/11/2026 :
// - RFC 8216 §4.3.4.1 et §4.3.4.2.1 : l'attribut URI d'un EXT-X-MEDIA de TYPE=AUDIO est FACULTATIF, et « a
//   missing URI attribute indicates that the media data for this Rendition is included in the Media Playlist »
//   de chaque EXT-X-STREAM-INF qui renvoie à ce groupe ; les autres rendus du groupe gardent leur URI. C'est la
//   forme exacte du levier a : la piste par défaut sans URI (dans les segments vidéo), les autres en groupe.
// - RFC 8216 §3.3 : l'init d'un segment fMP4 « MUST contain a Track Box ('trak') for every Track Fragment Box
//   ('traf') in the fMP4 Segment » — un init à deux `trak` (vidéo 1, son 2) et des fragments des deux pistes
//   dans un même segment sont du HLS valide.
// - **Mais la spécification d'auteur d'Apple le déconseille** (« HLS Authoring Specification for Apple
//   Devices ») : 9.5 « You SHOULD deliver video and audio as separate streams », 9.6 « If you have multichannel
//   audio, you MUST use separate audio streams », 9.7 « If you have alternative audio content
//   (languages/commentary/DVS), you MUST use separate audio streams », et 2.17 « A single Media Segment MUST
//   NOT contain multiple audio streams » (respecté : une seule piste son par segment). Le levier a est donc un
//   essai contre une règle d'Apple, pour mesurer ce que coûtent les requêtes séparées au démarrage ; il ne
//   deviendrait la règle qu'après une lecture sans faute sur iPhone, Mac et Apple TV.
// - RFC 8216 §4.3.5.2 : `EXT-X-START:TIME-OFFSET=<s>[,PRECISE=YES]` peut figurer dans la liste maître (§4.3.5 :
//   « either Master Playlists or Media Playlists ») ; PRECISE=YES : « clients SHOULD start playback at the
//   Media Segment containing the TIME-OFFSET » et n'affichent rien d'avant. La spécification d'Apple n'en dit
//   rien.
// - BANDWIDTH est le débit de crête (RFC 8216 §4.3.4.2) ; l'annoncer à la moyenne est un écart assumé,
//   d'essai seulement : AVFoundation pèse peut-être le débit annoncé contre le débit mesuré avant de repartir.

import { AUDIO_TRACK_ID, SEQUENCE_STRIDE, VIDEO_TRACK_ID } from "./format";

// ── La version d'un essai multiplexé ─────────────────────────────────────────

/** La révision de l'essai multiplexé : à monter si la façon de multiplexer change (ordre des fragments, init). */
export const LUMEN_MUX_REVISION = 1;
const MUX_SUFFIX = `m${LUMEN_MUX_REVISION}`;

/** `2-0123456789ab` → `2m1-0123456789ab` : la même lecture, le son par défaut multiplexé. */
export function muxVersion(version: string): string {
  const dash = version.indexOf("-");
  return dash < 0 ? version : `${version.slice(0, dash)}${MUX_SUFFIX}${version.slice(dash)}`;
}

/**
 * La version de format d'une adresse, sans l'essai multiplexé : `2m1` → `{ base: "2", mux: true }`. Une autre
 * révision (`2m9`) n'est pas reconnue : la base garde le suffixe, et `cuttingOfTag` la refuse (410).
 */
export function splitMuxTag(tag: string): { base: string; mux: boolean } {
  return tag.endsWith(MUX_SUFFIX) && tag.length > MUX_SUFFIX.length ? { base: tag.slice(0, -MUX_SUFFIX.length), mux: true } : { base: tag, mux: false };
}

// ── Les noms multiplexés ─────────────────────────────────────────────────────

export type MuxedPath = { kind: "playlist"; track: number } | { kind: "init"; track: number } | { kind: "segment"; track: number; n: number };

/** `vm3.m3u8`, `init-vm3.mp4`, `vm3/12.m4s` — strict comme `parseLumenPath` : deux adresses ne nomment jamais le même segment. */
export function parseMuxedPath(name: string): MuxedPath | null {
  let m = /^vm([1-9]\d{0,3})\.m3u8$/.exec(name);
  if (m) return { kind: "playlist", track: Number(m[1]) };
  m = /^init-vm([1-9]\d{0,3})\.mp4$/.exec(name);
  if (m) return { kind: "init", track: Number(m[1]) };
  m = /^vm([1-9]\d{0,3})\/(0|[1-9]\d{0,5})\.m4s$/.exec(name);
  if (m) return { kind: "segment", track: Number(m[1]), n: Number(m[2]) };
  return null;
}

export const muxedPlaylistName = (track: number) => `vm${track}.m3u8`;

// ── Les listes ───────────────────────────────────────────────────────────────

/**
 * La liste maître de l'essai multiplexé, tirée de celle de la règle : la piste `track` perd son URI (ses
 * données sont dans les segments vidéo, RFC 8216 §4.3.4.2.1), et la variante de son groupe lit `vm{track}.m3u8`
 * au lieu de `v.m3u8`. Les autres pistes du groupe, et les autres groupes (autres codecs, `v.m3u8` sans son),
 * ne changent pas. Une liste où la piste n'est pas servie est rendue telle quelle.
 */
export function muxedMaster(master: string, track: number): string {
  const lines = master.split("\n");
  const uri = `,URI="a${track}.m3u8"`;
  const media = lines.findIndex((l) => l.startsWith("#EXT-X-MEDIA:") && l.endsWith(uri));
  if (media < 0) return master;
  const group = /GROUP-ID="([^"]*)"/.exec(lines[media])?.[1];
  lines[media] = lines[media].slice(0, -uri.length);
  for (let i = 0; i < lines.length - 1; i++) {
    if (lines[i].startsWith("#EXT-X-STREAM-INF:") && lines[i].includes(`AUDIO="${group}"`) && lines[i + 1] === "v.m3u8") lines[i + 1] = muxedPlaylistName(track);
  }
  return lines.join("\n");
}

/** La liste média multiplexée : celle de la vidéo, avec l'init et les segments multiplexés — mêmes EXTINF. */
export function muxedMediaPlaylist(videoPlaylist: string, track: number): string {
  return videoPlaylist
    .split("\n")
    .map((l) => (l === '#EXT-X-MAP:URI="init-v.mp4"' ? `#EXT-X-MAP:URI="init-vm${track}.mp4"` : l.replace(/^v\/(\d+)\.m4s$/, `vm${track}/$1.m4s`)))
    .join("\n");
}

/** Les options d'essai lues sur la requête de la liste maître : rien de lu = la liste de la règle. */
export interface MasterTrialOptions {
  /** `?start=<s>` : `EXT-X-START:TIME-OFFSET=<s>,PRECISE=YES` (levier c). */
  startS?: number;
  /** `?bw=moyen` : BANDWIDTH annoncé au débit moyen plutôt qu'à la crête (levier d). */
  averageBandwidth?: boolean;
  /**
   * `?bw=bas` : BANDWIDTH et AVERAGE-BANDWIDTH annoncés au quart (passe « Attente de Safari », 17/11/2026). Un
   * mensonge assumé, d'essai seulement : Safari attend jusqu'à ~12 s d'avance avant de lancer l'image après un saut
   * (0,9 à 4 s, contre 0,7 s au lecteur actuel) ; s'il pèse le débit annoncé contre le débit mesuré, il se croira en
   * avance plus tôt. `moyen` n'avait rien montré de net (16/11).
   */
  lowBandwidth?: boolean;
}

/** Le facteur du débit annoncé sous `?bw=bas`. */
export const LOW_BANDWIDTH_DIVISOR = 4;

/** `?start=` et `?bw=` (`moyen`, `bas`) ; une valeur mal formée est ignorée (la liste de la règle), jamais une erreur. */
export function masterTrialOptions(params: URLSearchParams): MasterTrialOptions {
  const out: MasterTrialOptions = {};
  const start = params.get("start");
  if (start && /^\d{1,6}(\.\d{1,3})?$/.test(start) && Number(start) > 0) out.startS = Number(start);
  if (params.get("bw") === "moyen") out.averageBandwidth = true;
  if (params.get("bw") === "bas") out.lowBandwidth = true;
  return out;
}

/** Applique les options d'essai à une liste maître ; sans option, le texte est rendu à l'identique. */
export function withMasterTrials(master: string, options: MasterTrialOptions): string {
  let text = master;
  // Les débits ne se touchent que sur la variante d'origine (`v.m3u8`, ou `vm{N}.m3u8` multiplexée) : les échelons de la
  // version allégée (`l1x…`) gardent leurs débits honnêtes — divisés, Safari croirait l'origine aussi légère qu'eux et ne
  // choisirait plus juste (17/11/2026).
  const onOrigin = (rewrite: (line: string) => string) => {
    const lines = text.split("\n");
    for (let i = 0; i + 1 < lines.length; i++) {
      if (lines[i].startsWith("#EXT-X-STREAM-INF:") && /^vm?\d*\.m3u8$/.test(lines[i + 1])) lines[i] = rewrite(lines[i]);
    }
    text = lines.join("\n");
  };
  if (options.averageBandwidth) {
    onOrigin((line) => line.replace(/^(#EXT-X-STREAM-INF:)BANDWIDTH=\d+,AVERAGE-BANDWIDTH=(\d+)/, "$1BANDWIDTH=$2,AVERAGE-BANDWIDTH=$2"));
  }
  if (options.lowBandwidth) {
    const quarter = (v: string) => String(Math.max(1, Math.round(Number(v) / LOW_BANDWIDTH_DIVISOR)));
    onOrigin((line) => line.replace(/\b(BANDWIDTH|AVERAGE-BANDWIDTH)=(\d+)/g, (_m, k: string, v: string) => `${k}=${quarter(v)}`));
  }
  if (options.startS !== undefined) {
    // Juste après `#EXTM3U` : une balise de liste maître, une seule fois (RFC 8216 §4.3.5).
    text = text.replace(/^#EXTM3U\n/, `#EXTM3U\n#EXT-X-START:TIME-OFFSET=${options.startS},PRECISE=YES\n`);
  }
  return text;
}

// ── Les octets : init et segments multiplexés ────────────────────────────────

interface Box {
  type: string;
  start: number;
  end: number;
}

/** Les boîtes de `bytes[from, to)` ; une taille incohérente lève (les octets viennent de notre muxer). */
function boxes(bytes: Uint8Array, from = 0, to = bytes.length): Box[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out: Box[] = [];
  let at = from;
  while (at + 8 <= to) {
    const size = view.getUint32(at);
    const type = String.fromCharCode(bytes[at + 4], bytes[at + 5], bytes[at + 6], bytes[at + 7]);
    if (size < 8 || at + size > to) throw new Error(`Boîte ${type} mal formée à ${at}.`);
    out.push({ type, start: at, end: at + size });
    at += size;
  }
  return out;
}

function child(bytes: Uint8Array, parent: Box, type: string): Box {
  const found = boxes(bytes, parent.start + 8, parent.end).find((b) => b.type === type);
  if (!found) throw new Error(`Pas de ${type} dans ${parent.type}.`);
  return found;
}

function wrap(type: string, ...parts: Uint8Array[]): Uint8Array {
  const size = 8 + parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(size);
  new DataView(out.buffer).setUint32(0, size);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  let at = 8;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

const slice = (bytes: Uint8Array, b: Box) => bytes.subarray(b.start, b.end);

/**
 * L'init multiplexé : `ftyp`, puis un `moov` à deux pistes — le `mvhd` et la `trak` vidéo de l'init vidéo, la
 * `trak` son de l'init de la piste, et un `mvex` avec les deux `trex`. Les identifiants sont déjà distincts
 * (`VIDEO_TRACK_ID` 1, `AUDIO_TRACK_ID` 2, format.ts) et `mvhd` ne réserve aucun identifiant suivant.
 */
export function muxedInit(videoInit: Uint8Array, audioInit: Uint8Array): Uint8Array {
  const top = (bytes: Uint8Array) => {
    const list = boxes(bytes);
    const ftyp = list.find((b) => b.type === "ftyp");
    const moov = list.find((b) => b.type === "moov");
    if (!ftyp || !moov) throw new Error("Init sans ftyp ou moov.");
    return { ftyp, moov };
  };
  const v = top(videoInit);
  const a = top(audioInit);
  const vMvex = child(videoInit, v.moov, "mvex");
  const aMvex = child(audioInit, a.moov, "mvex");
  return new Uint8Array([
    ...slice(videoInit, v.ftyp),
    ...wrap(
      "moov",
      slice(videoInit, child(videoInit, v.moov, "mvhd")),
      slice(videoInit, child(videoInit, v.moov, "trak")),
      slice(audioInit, child(audioInit, a.moov, "trak")),
      wrap("mvex", slice(videoInit, child(videoInit, vMvex, "mehd")), slice(videoInit, child(videoInit, vMvex, "trex")), slice(audioInit, child(audioInit, aMvex, "trex")))
    ),
  ]);
}

interface Fragment {
  /** Les octets moof + mdat, copiés (le numéro de séquence y est réécrit). */
  bytes: Uint8Array;
  /** `tfdt` de la piste du fragment (µs, l'échelle commune) : l'ordre d'entrelacement. */
  decodeUs: number;
  video: boolean;
}

function fragmentsOf(bytes: Uint8Array): Fragment[] {
  const list = boxes(bytes);
  const out: Fragment[] = [];
  for (let i = 0; i < list.length; i++) {
    const moof = list[i];
    if (moof.type !== "moof") continue;
    const mdat = list[i + 1];
    if (!mdat || mdat.type !== "mdat") throw new Error("moof sans mdat.");
    const traf = child(bytes, moof, "traf");
    const tfhd = child(bytes, traf, "tfhd");
    const tfdt = child(bytes, traf, "tfdt");
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const trackId = view.getUint32(tfhd.start + 12);
    const version = bytes[tfdt.start + 8];
    const decodeUs = version === 1 ? Number(view.getBigUint64(tfdt.start + 12)) : view.getUint32(tfdt.start + 12);
    out.push({ bytes: bytes.slice(moof.start, mdat.end), decodeUs, video: trackId === VIDEO_TRACK_ID });
    i += 1;
  }
  return out;
}

/**
 * Le segment multiplexé `n` : les fragments du segment vidéo et ceux du segment son de la même plage,
 * entrelacés par instant de décodage (à égalité, la vidéo d'abord : l'image qui ouvre le segment arrive la
 * première), puis renumérotés `n × 1000 + rang + 1` — le `mfhd` reste strictement croissant dans le segment et
 * d'un segment à l'autre, comme ceux de la règle (`SEQUENCE_STRIDE`). Chaque `trun` désigne ses échantillons
 * depuis le début de son propre `moof` (default-base-is-moof) : déplacer un fragment entier ne change rien à ses
 * adresses. Les octets des échantillons sont exactement ceux des deux segments de la règle.
 */
export function muxedSegment(video: Uint8Array, audio: Uint8Array, n: number): Uint8Array {
  const parts = [...fragmentsOf(video), ...fragmentsOf(audio)];
  parts.sort((x, y) => x.decodeUs - y.decodeUs || Number(y.video) - Number(x.video));
  const out = new Uint8Array(parts.reduce((s, f) => s + f.bytes.length, 0));
  let at = 0;
  parts.forEach((f, rank) => {
    // mfhd : premier enfant du moof — taille, type, version et drapeaux, puis le numéro (moof + 8 + 12).
    if (String.fromCharCode(...f.bytes.subarray(12, 16)) !== "mfhd") throw new Error("moof sans mfhd en tête.");
    new DataView(f.bytes.buffer, f.bytes.byteOffset).setUint32(20, n * SEQUENCE_STRIDE + rank + 1);
    out.set(f.bytes, at);
    at += f.bytes.length;
  });
  return out;
}

/** Pour les tests : les pistes et numéros de séquence d'un segment, dans l'ordre. */
export function describeFragments(bytes: Uint8Array): { track: number; sequence: number; decodeUs: number }[] {
  return fragmentsOf(bytes).map((f) => ({
    track: f.video ? VIDEO_TRACK_ID : AUDIO_TRACK_ID,
    sequence: new DataView(f.bytes.buffer, f.bytes.byteOffset).getUint32(20),
    decodeUs: f.decodeUs,
  }));
}
