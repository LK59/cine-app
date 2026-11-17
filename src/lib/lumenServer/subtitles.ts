// Les sous-titres de Lumen serveur **dans le flux HLS** : un rendu `TYPE=SUBTITLES` dans la liste maître, une liste
// média de WebVTT découpé sur la grille des segments vidéo (DECISIONS.md §191).
//
// Pourquoi : en AirPlay, l'Apple TV (ou un téléviseur AirPlay d'une autre marque) ne reçoit que l'adresse de la liste
// maître et lit le flux elle-même, sans la page. Les sous-titres de Lumen serveur sont dessinés par la page (§190) :
// rien n'allait au téléviseur, et « Diffuser » avec un sous-titre affiché passait au lecteur serveur (un transcodage
// Jellyfin, sous-titre incrusté). Un rendu de sous-titres dans la liste maître est la forme qu'Apple lit sur tous ses
// appareils (HLS Authoring Specification, « Subtitles ») ; le téléviseur le dessine lui-même.
//
// **Seulement sur demande** : `master.m3u8?st=<index Jellyfin>`. Sans `st`, la liste maître est celle d'avant à
// l'octet près — c'est elle que la page lit sur l'iPhone, où un rendu de sous-titres risquerait d'être dessiné par
// Safari sous notre calque (§190), ou de faire refuser l'élément comme les `<track>` posés avec l'adresse (code 4,
// b8e3682d). L'hôte ne pose `st` que pendant une diffusion (`LumenServerHost`, `castSubtitleWanted`), et le banc
// `/lumen-test` l'essaie dans la page (levier « sous-titres dans la liste ») avant qu'on s'y fie.
//
// **Un seul rendu, celui choisi**, DEFAULT=YES, AUTOSELECT=YES (FORCED=YES pour un forcé) : le téléviseur n'a rien à
// choisir, et un récepteur AirPlay de téléviseur (TCL, Samsung, LG) n'a souvent pas de menu de pistes (`castSubtitle.ts`).
// Changer de sous-titre pendant la diffusion, c'est une autre adresse (`st` différent) rouverte à la position.
//
// **Sans état, comme le reste de Lumen serveur** (§155) : le nom d'un rendu (`s3h1a2b3c4d.m3u8`) porte l'index
// Jellyfin et une empreinte de ce qui fait ses octets — la source, la piste (codec, langue, titre, drapeaux, fichier à
// côté), la version de sa correction de synchro (§141) et `LUMEN_SUBTITLE_REVISION`. Une piste qui a changé chez
// Jellyfin, ou une synchro refaite, est une autre adresse ; l'ancienne répond 410. La découpe et le délai D viennent de
// l'index du fichier, déjà dans la version de l'adresse.
//
// Code pur, sans Node : les tests le lisent directement ; ce qui parle à Jellyfin est dans `subtitleServe.ts`.

import { normaliseLanguage, isForcedTrack } from "@/lib/trackPreferences";
import { targetDurationOf } from "./plan";
import { extinfSeconds } from "./playlists";
import type { LumenSegment } from "./format";

/** Le groupe des rendus de sous-titres dans la liste maître. */
export const LUMEN_SUBTITLE_GROUP = "subs";

/**
 * La révision de la découpe des sous-titres : à monter quand change ce que produit `subtitleSegment` (appartenance
 * d'une réplique à un segment, `X-TIMESTAMP-MAP`, nettoyage du texte). Elle entre dans l'empreinte du nom de rendu :
 * une autre règle, d'autres adresses, sans toucher à `LUMEN_FORMAT_VERSION` (qui invaliderait tous les index).
 */
export const LUMEN_SUBTITLE_REVISION = 1;

/** Les codecs de sous-titres en images : Jellyfin ne les convertit pas en WebVTT. Le lecteur serveur les incruste. */
const IMAGE_CODECS = new Set(["pgssub", "hdmv_pgs_subtitle", "pgs", "dvdsub", "dvd_subtitle", "vobsub", "dvbsub", "dvb_subtitle", "xsub"]);

/** Une piste de sous-titres de l'élément, telle que Jellyfin la décrit, avec sa synchro appliquée (§141). */
export interface LumenSubtitleTrack {
  /** L'index Jellyfin (`MediaStreams[].Index`) : celui que la page et la route des sous-titres connaissent. */
  index: number;
  language: string | null;
  title: string | null;
  codec: string | null;
  isDefault: boolean;
  isForced: boolean;
  isHearingImpaired: boolean;
  isExternal: boolean;
  /** Le chemin d'un fichier à côté du film (un autre fichier sous le même index est une autre piste). */
  path: string | null;
  /** `IsTextSubtitleStream` de Jellyfin : `false` pour une piste en images. */
  isText: boolean | null;
  /** La correction appliquée et sa version (§141), ou null. */
  sync: { offset: number; scale: number; version: number } | null;
}

/** Une piste que ce chemin peut porter au téléviseur : du texte que Jellyfin convertit en WebVTT. */
export function isCarriableSubtitle(track: Pick<LumenSubtitleTrack, "isText" | "codec" | "index">): boolean {
  if (track.index < 0 || track.isText === false) return false;
  return !IMAGE_CODECS.has((track.codec ?? "").toLowerCase());
}

/** FNV-1a 32 bits, en hexadécimal sur 8 caractères : une empreinte courte et stable, pas un secret. */
function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  const bytes = new TextEncoder().encode(text);
  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/**
 * Le nom d'un rendu : `s{index}h{empreinte}`. L'empreinte couvre tout ce qui fait les octets servis sous ce nom — voir
 * l'en-tête. Le chemin d'un fichier à côté y entre : Jellyfin numérote ces fichiers après les pistes du conteneur, et
 * un fichier ajouté peut décaler les index.
 */
export function subtitleRenditionTag(mediaSourceId: string, track: LumenSubtitleTrack): string {
  const facts = [
    LUMEN_SUBTITLE_REVISION,
    mediaSourceId.toLowerCase(),
    track.index,
    track.codec ?? "",
    track.language ?? "",
    track.title ?? "",
    track.isForced ? 1 : 0,
    track.isHearingImpaired ? 1 : 0,
    track.isExternal ? 1 : 0,
    track.path ?? "",
    track.sync ? track.sync.version : "",
  ].join("\u0001");
  return `s${track.index}h${fnv1a(facts)}`;
}

export type LumenSubtitlePath = { kind: "playlist"; tag: string; index: number } | { kind: "segment"; tag: string; index: number; n: number };

/**
 * Le pendant de ces noms : `s3h1a2b3c4d.m3u8`, `s3h1a2b3c4d/12.vtt`, ou null. Strict comme `parseLumenPath` (pas de
 * zéros en tête) : deux adresses ne désignent jamais le même segment. À part de `parseLumenPath` exprès : ces noms ne
 * sont ni des pistes du fichier ni des fMP4, et le moteur (`engine.resolve`) ne doit pas les voir.
 */
export function parseSubtitlePath(name: string): LumenSubtitlePath | null {
  let m = /^(s(0|[1-9]\d{0,3})h[0-9a-f]{8})\.m3u8$/.exec(name);
  if (m) return { kind: "playlist", tag: m[1], index: Number(m[2]) };
  m = /^(s(0|[1-9]\d{0,3})h[0-9a-f]{8})\/(0|[1-9]\d{0,5})\.vtt$/.exec(name);
  if (m) return { kind: "segment", tag: m[1], index: Number(m[2]), n: Number(m[3]) };
  return null;
}

/**
 * `?st=` sur la liste maître : un index Jellyfin, `"premier"` (le banc `/lumen-test` : la première piste de texte, sans
 * connaître les index), `undefined` (pas de sous-titres : la liste d'avant), ou null (mal formé).
 */
export function parseSubtitleParam(raw: string | null | undefined): number | "premier" | undefined | null {
  if (raw === null || raw === undefined || raw === "") return undefined;
  if (raw === "premier") return "premier";
  return /^(0|[1-9]\d{0,3})$/.test(raw) ? Number(raw) : null;
}

/** La piste que `st` désigne, parmi celles que ce chemin peut porter ; null sinon (une image, un index inconnu). */
export function chosenSubtitle(tracks: readonly LumenSubtitleTrack[], wanted: number | "premier"): LumenSubtitleTrack | null {
  const carriable = tracks.filter(isCarriableSubtitle);
  if (wanted === "premier") return carriable[0] ?? null;
  return carriable.find((t) => t.index === wanted) ?? null;
}

/** Une chaîne entre guillemets HLS : ni guillemet, ni retour à la ligne (rfc8216bis §4.2) — celle de `playlists.ts`. */
function quoted(value: string): string {
  return `"${value.replace(/["\r\n]/g, (c) => (c === '"' ? "'" : " "))}"`;
}

/** Ce que la liste maître dit d'un rendu de sous-titres. */
export interface SubtitleRenditionLine {
  /** Le nom du rendu (`subtitleRenditionTag`) : l'URI relative est `{tag}.m3u8`. */
  tag: string;
  track: LumenSubtitleTrack;
  /** L'étiquette (`trackLabel.ts`, celle des menus des lecteurs). */
  name: string;
}

/**
 * La ligne `EXT-X-MEDIA` d'un rendu choisi : DEFAULT=YES et AUTOSELECT=YES (le téléviseur le prend sans menu) ;
 * FORCED=YES pour un forcé (un rendu forcé doit être sélectionnable d'office : AUTOSELECT=YES) ; pour des sous-titres
 * pour malentendants, les CHARACTERISTICS qu'Apple attend d'un rendu SDH (`transcribes-spoken-dialog`,
 * `describes-music-and-sound`). L'URI est
 * relative : sous `…/tv.{jeton}/`, le téléviseur hérite du laissez-passer (§186) sans une ligne réécrite.
 */
export function subtitleMediaLine(line: SubtitleRenditionLine): string {
  const { track } = line;
  const forced = isForcedTrack({ language: track.language, name: track.title, isDefault: track.isDefault, isForced: track.isForced });
  const attributes = [
    "TYPE=SUBTITLES",
    `GROUP-ID=${quoted(LUMEN_SUBTITLE_GROUP)}`,
    `LANGUAGE=${quoted(normaliseLanguage(track.language) ?? "und")}`,
    `NAME=${quoted(line.name)}`,
    "DEFAULT=YES",
    "AUTOSELECT=YES",
  ];
  if (forced) attributes.push("FORCED=YES");
  if (track.isHearingImpaired && !forced) attributes.push(`CHARACTERISTICS=${quoted("public.accessibility.transcribes-spoken-dialog,public.accessibility.describes-music-and-sound")}`);
  attributes.push(`URI=${quoted(`${line.tag}.m3u8`)}`);
  return `#EXT-X-MEDIA:${attributes.join(",")}`;
}

/**
 * La liste maître de la règle, augmentée du rendu choisi : sa ligne `EXT-X-MEDIA` avant la première variante, et
 * `SUBTITLES="subs"` sur chaque variante (rfc8216bis §4.4.6.2 : toute variante qui le nomme). Le reste est rendu
 * tel quel, octet pour octet : une transformation de texte à part de `masterPlaylist`, pour que les autres essais
 * et chantiers sur la liste maître se fusionnent sans se toucher.
 */
export function withSubtitleRendition(master: string, line: SubtitleRenditionLine): string {
  const lines = master.replace(/\n$/, "").split("\n");
  const first = lines.findIndex((l) => l.startsWith("#EXT-X-STREAM-INF:"));
  if (first < 0) return master;
  const out: string[] = [];
  lines.forEach((l, i) => {
    if (i === first) out.push(subtitleMediaLine(line));
    out.push(l.startsWith("#EXT-X-STREAM-INF:") && !/(^|,)SUBTITLES=/.test(l.slice(18)) ? `${l},SUBTITLES=${quoted(LUMEN_SUBTITLE_GROUP)}` : l);
  });
  return `${out.join("\n")}\n`;
}

/**
 * La liste média d'un rendu : les **mêmes** segments que la vidéo (mêmes EXTINF, même EXT-X-TARGETDURATION — règle
 * 8.2 d'Apple), chacun un WebVTT `{tag}/{n}.vtt`. Ni EXT-X-MAP ni fMP4 : un WebVTT segmenté est la forme qu'Apple
 * demande pour HLS (« WebVTT segments »), et un seul fichier pour tout le film n'est pas une forme qu'elle décrit.
 */
export function subtitleMediaPlaylist(segments: readonly LumenSegment[], tag: string): string {
  if (segments.length === 0) throw new Error("Index sans segments.");
  const lines = ["#EXTM3U", "#EXT-X-VERSION:7", `#EXT-X-TARGETDURATION:${targetDurationOf(segments)}`, "#EXT-X-MEDIA-SEQUENCE:0", "#EXT-X-PLAYLIST-TYPE:VOD"];
  segments.forEach((s, n) => lines.push(`#EXTINF:${extinfSeconds(s.endUs - s.startUs)},`, `${tag}/${n}.vtt`));
  lines.push("#EXT-X-ENDLIST");
  return `${lines.join("\n")}\n`;
}

// ── Le WebVTT ────────────────────────────────────────────────────────────────

/** Une réplique : ses instants en millisecondes **du fichier** (ceux du WebVTT de Jellyfin, synchro appliquée). */
export interface VttCue {
  startMs: number;
  endMs: number;
  /** Les réglages de position après le second instant (`line:90% align:center`), tels quels. */
  settings: string;
  text: string;
}

const STAMP = String.raw`(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})`;
const TIMING = new RegExp(String.raw`^\s*${STAMP}\s+-->\s+${STAMP}(.*)$`);

function stampMs(h: string | undefined, m: string, s: string, frac: string): number {
  return Number(h ?? 0) * 3_600_000 + Number(m) * 60_000 + Number(s) * 1000 + Math.round(Number(frac) * 10 ** (3 - frac.length));
}

/**
 * Les répliques d'un WebVTT, dans l'ordre de leur début (stable). L'en-tête, les blocs `NOTE`, `STYLE` et `REGION`
 * sont écartés ; l'identifiant d'une réplique aussi (deux segments répètent la même réplique : un identifiant
 * répété serait faux). Une réplique sans durée ou sans texte n'est rien.
 */
export function parseVttCues(vtt: string): VttCue[] {
  const blocks = vtt.replace(/^﻿/, "").replace(/\r\n?/g, "\n").split(/\n[ \t]*\n/);
  const cues: VttCue[] = [];
  for (const block of blocks) {
    const lines = block.split("\n");
    // L'en-tête, `NOTE`, `STYLE`, `REGION` n'ont pas de ligne d'instants (un `-->` y est interdit) : écartés par là.
    const at = lines.findIndex((l) => TIMING.test(l));
    if (at < 0) continue;
    const m = TIMING.exec(lines[at])!;
    const startMs = stampMs(m[1], m[2], m[3], m[4]);
    const endMs = stampMs(m[5], m[6], m[7], m[8]);
    const text = lines
      .slice(at + 1)
      .join("\n")
      .replace(/-->/g, "→")
      .trim();
    if (endMs <= startMs || !text) continue;
    cues.push({ startMs, endMs, settings: m[9].trim(), text });
  }
  return cues
    .map((cue, i) => ({ cue, i }))
    .sort((a, b) => a.cue.startMs - b.cue.startMs || a.cue.endMs - b.cue.endMs || a.i - b.i)
    .map(({ cue }) => cue);
}

/** `hh:mm:ss.mmm`, la forme longue partout (un film dépasse l'heure). */
export function vttTimestamp(ms: number): string {
  const v = Math.max(0, Math.round(ms));
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${pad(Math.floor(v / 3_600_000))}:${pad(Math.floor(v / 60_000) % 60)}:${pad(Math.floor(v / 1000) % 60)}.${pad(v % 1000, 3)}`;
}

/**
 * `X-TIMESTAMP-MAP` : l'instant MPEG-2 (90 kHz) des autres rendus qui correspond à l'instant 0 des répliques.
 *
 * Les répliques sont datées sur le temps du fichier (le WebVTT de Jellyfin, comme le lecteur natif le lit). Les
 * segments fMP4 de Lumen serveur ne le sont pas tout à fait : chaque échantillon y est présenté à son instant du
 * fichier **plus le délai D** (`segment.ts` : `compositionOffset + delayUs` pour la vidéo, `timestamp + delayUs` pour le
 * son ; aucune liste de montage dans l'init — `mp4Muxer.ts` n'écrit pas d'`elst`). L'instant 0 du fichier est donc
 * l'instant D du flux : `MPEGTS = round(D × 90 000)`, `LOCAL = 0`. rfc8216bis §3.6 : sans la balise, le client
 * suppose que 0 des répliques vaut 0 du flux — chaque réplique arriverait D trop tôt (100 à 200 ms : visible).
 * Cette correspondance tient quelle que soit la façon dont le lecteur règle son horloge, puisqu'elle relie deux
 * instants du flux et non de la liste.
 */
export function timestampMap(delayUs: number): string {
  return `X-TIMESTAMP-MAP=MPEGTS:${Math.max(0, Math.round((delayUs * 9) / 100))},LOCAL:00:00:00.000`;
}

/**
 * Le WebVTT du segment `n` : chaque réplique qui recoupe `[début, fin)` du segment (temps du fichier), entière et
 * avec ses instants d'origine. Une réplique à cheval sur une frontière est donc **dans les deux segments**, à
 * l'identique — la règle des WebVTT segmentés en HLS : une réplique qui couvre plusieurs segments est répétée dans
 * chacun, et le lecteur reconnaît le doublon (mêmes instants, même texte) pour ne l'afficher qu'une fois. Le premier
 * segment prend aussi ce qui commencerait avant 0, le dernier tout ce qui dépasse la durée annoncée. Un segment sans
 * réplique reste un WebVTT valable (l'en-tête seul).
 */
export function subtitleSegment(cues: readonly VttCue[], segments: readonly LumenSegment[], n: number, delayUs: number): string {
  const segment = segments[n];
  if (!segment) throw new Error(`Segment ${n} inexistant (${segments.length}).`);
  const from = n === 0 ? -Infinity : segment.startUs / 1000;
  const to = n === segments.length - 1 ? Infinity : segment.endUs / 1000;
  const parts = ["WEBVTT", timestampMap(delayUs), ""];
  for (const cue of cues) {
    if (cue.startMs >= to || cue.endMs <= from) continue;
    parts.push(`${vttTimestamp(cue.startMs)} --> ${vttTimestamp(cue.endMs)}${cue.settings ? ` ${cue.settings}` : ""}`, cue.text, "");
  }
  return `${parts.join("\n")}\n`;
}
