// Le relevé serveur d'une lecture Lumen serveur (étape 3, DECISIONS.md §156).
//
// Pourquoi : en HLS natif, la page ne voit rien de ce que Safari demande. Le lecteur dans la page
// (Lumen MSE) mesure lui-même ses attentes, ses octets et ses reconstructions (`diag.*` de
// player.log) ; ici, c'est AVFoundation qui tire les segments, et une attente de dix secondes peut
// venir du disque (X-Ray lit les mêmes fichiers), de la file de construction, d'un segment 4K de
// 40 Mo, du trajet — rien, côté page, ne permet de trancher. Le serveur, lui, voit chaque requête :
// il en tient le compte par lecture, et l'étape 4 l'ajoute aux lignes `stop`, `stall`, `error` et
// `fallback` (`srv.*`) au moment où la page les envoie (README de docs/remux-serveur, décision 12).
//
// - **Sans état nécessaire au service** : l'identifiant de lecture (`s`) est dans le chemin des
//   adresses, propagé de lui-même aux URI relatives des listes. Un segment demandé avec un `s` que le
//   serveur a oublié (redémarrage, éviction) est servi pareil ; seul le relevé repart de zéro.
// - **Sur `globalThis`** (`Symbol.for("cine-app.lumenServer.playbacks")`) : chaque route a sa copie du
//   module, et la route du journal du lecteur (étape 4) en aura une autre.
// - **Borné** : 300 lectures, une lecture oubliée après six heures sans requête — une séance tient
//   quelques centaines d'octets.
// - **Le compte qui a ouvert la lecture** est noté : le relevé d'une lecture ne s'ajoute qu'aux lignes
//   du même compte (`lumenPlaybackFields`).

const STATE = Symbol.for("cine-app.lumenServer.playbacks");
export const MAX_PLAYBACKS = 300;
export const PLAYBACK_IDLE_MS = 6 * 60 * 60 * 1000;
/**
 * La trace d'une lecture : ses derniers segments remis, un par ligne courte. Elle sert la page de banc
 * `/lumen-test` (étape 3b, §157) — qu'a demandé Safari après un saut, le segment d'avant ? —, pas les
 * lignes du journal du lecteur. 200 entrées de ~40 octets : 8 Ko par lecture, 2,4 Mo au pire pour 300.
 * 80 jusqu'à l'étape 3c : un parcours de 20 sauts n'en gardait que les cinq ou six derniers, et l'analyse de
 * ce que Safari charge entre `seeked` et la reprise (README, « Étape 3c ») manquait de sauts.
 */
export const TRACE_ENTRIES = 200;

/** Un identifiant de lecture tel que les adresses le portent : celui que la page tire (étape 4), ou celui que le serveur donne. */
export function isPlaybackId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{4,64}$/.test(value);
}

export type RequestKind = "master" | "playlist" | "init" | "segment";

export interface PlaybackStats {
  s: string;
  user: string;
  itemId: string;
  version: string;
  firstAt: number;
  lastAt: number;
  requests: Record<RequestKind, number>;
  /** Segments servis en entier (vidéo, son). */
  video: number;
  audio: number;
  /** Octets de segments et d'init remis. */
  bytes: number;
  /** Construction dans le fil de calcul (somme, pire). */
  buildMs: number;
  buildMaxMs: number;
  /** Attente dans la file avant la construction (somme, pire) : la charge du serveur. */
  waitMs: number;
  waitMaxMs: number;
  /** Attente du disque pendant les constructions (somme). */
  diskMs: number;
  /** Du premier au dernier octet remis au réseau (somme, pire) : le trajet vu du serveur. */
  sendMs: number;
  sendMaxMs: number;
  /** Segments déjà préparés (`prepare`) ou partagés avec une requête identique en vol. */
  reused: number;
  /** Envois coupés par le client avant la fin (Safari annule les segments d'avant un saut). */
  aborted: number;
  /** Réponses « occupé » (file pleine). */
  busy: number;
  /** Adresses d'une autre version du fichier ou du format (410). */
  stale: number;
  /**
   * Segments vidéo ouverts par une image qui n'est pas une clé (un point d'index qui ment, pris par
   * l'index des Cues, §158) : un saut qui y tombe montre des images abîmées. Compté une fois par segment
   * construit.
   */
  falseKeys: number;
  /** Erreurs réelles (500), et la dernière. */
  errors: number;
  lastError: string | null;
  /** Le plus haut segment vidéo demandé, et le dernier. */
  lastVideoN: number | null;
  maxVideoN: number | null;
  /** Segments audio remis, par piste (numéro dans le fichier) : un changement de piste se voit ici. */
  audioByTrack: Record<number, number>;
  /**
   * Les segments son convertis (phase 2, §161) : combien, d'où (fabriqués, mémoire, disque, partagés avec une
   * conversion en vol), le temps de ffmpeg et de la lecture du fichier (somme, pire), l'attente (somme, pire), et
   * les « occupé » de la conversion. Null tant que la lecture n'a demandé aucun segment converti.
   */
  conv: ConvStats | null;
  /**
   * Les derniers segments remis, du plus ancien au plus récent : `+12.3s v/41 b23 w0 e45`
   * (depuis la première requête, nom, construction, attente dans la file, envoi), `p` s'il était
   * préparé ou partagé, `x` si l'envoi a été coupé. Voir `TRACE_ENTRIES`.
   */
  trace: string[];
  /**
   * La chronologie de la lecture, requête par requête (étape 3e, DECISIONS §160) — seulement si la page de banc l'a
   * demandée (`markChrono`, route `chrono`) ; null sinon : les lectures ordinaires (étape 4) n'en paient rien.
   */
  chrono: ChronoEntry[] | null;
}

/**
 * Une requête de la lecture, horodatée par le serveur (étape 3e) : ce que la page ne voit pas d'un HLS natif.
 * `at` est l'arrivée dans la route, sur l'horloge du serveur (`serverClockMs` : ms depuis l'époque, à la
 * fraction près) — la page la ramène sur la sienne avec le décalage mesuré par la route `chrono`. Les autres
 * instants sont relatifs à `at`, en ms :
 * - `ready` : la réponse est prête (liste écrite, init lu, segment construit — file et disque compris) ;
 * - `first` / `last` : le premier et le dernier morceau de 256 Kio remis au réseau (segments seulement).
 *   **Remis n'est pas reçu** : entre Node et l'iPhone, les tampons du noyau (les deux sockets) et du relais
 *   inverse tiennent plusieurs Mo — un segment de 3 Mo « part » en 2 ms. `last` est donc un minorant de
 *   l'arrivée, et un débit calculé dessus un majorant, sauf sur une rafale bien plus grosse que ces tampons.
 */
export interface ChronoEntry {
  name: string;
  at: number;
  ready?: number;
  first?: number;
  last?: number;
  bytes?: number;
  /** Construction et attente dans la file (segments construits pour cette requête). */
  build?: number;
  wait?: number;
  reused?: boolean;
  aborted?: boolean;
  /** Un statut autre que 200 (410, 409, 503, 500). */
  status?: number;
}

export interface ConvStats {
  segments: number;
  built: number;
  ram: number;
  disk: number;
  shared: number;
  convMs: number;
  convMaxMs: number;
  feedMs: number;
  waitMs: number;
  waitMaxMs: number;
  busy: number;
}

/** Les requêtes gardées par lecture chronométrée : une série de 20 sauts en fait ~500. */
export const CHRONO_ENTRIES = 800;

/** L'horloge des horodatages de la chronologie : ms depuis l'époque, à la fraction près, monotone dans le processus. */
export function serverClockMs(): number {
  return performance.timeOrigin + performance.now();
}

interface State {
  playbacks: Map<string, PlaybackStats>;
}

function state(): State {
  const g = globalThis as unknown as Record<symbol, State | undefined>;
  return (g[STATE] ??= { playbacks: new Map() });
}

function sweep(s: State, now: number): void {
  for (const [id, p] of s.playbacks) if (now - p.lastAt > PLAYBACK_IDLE_MS) s.playbacks.delete(id);
}

/** Le relevé de la lecture `s`, créé à sa première requête. */
export function playbackOf(s: string, init: { user: string; itemId: string; version: string }, now = Date.now()): PlaybackStats {
  const st = state();
  const key = `${init.user}\u0000${s}`;
  let p = st.playbacks.get(key);
  if (!p) {
    sweep(st, now);
    p = {
      s,
      user: init.user,
      itemId: init.itemId,
      version: init.version,
      firstAt: now,
      lastAt: now,
      requests: { master: 0, playlist: 0, init: 0, segment: 0 },
      video: 0,
      audio: 0,
      bytes: 0,
      buildMs: 0,
      buildMaxMs: 0,
      waitMs: 0,
      waitMaxMs: 0,
      diskMs: 0,
      sendMs: 0,
      sendMaxMs: 0,
      reused: 0,
      aborted: 0,
      busy: 0,
      stale: 0,
      falseKeys: 0,
      errors: 0,
      lastError: null,
      lastVideoN: null,
      maxVideoN: null,
      audioByTrack: {},
      conv: null,
      trace: [],
      chrono: null,
    };
    st.playbacks.set(key, p);
    // Le plus ancien part : une `Map` garde l'ordre d'insertion, et une lecture vivante est réinsérée.
    while (st.playbacks.size > MAX_PLAYBACKS) st.playbacks.delete(st.playbacks.keys().next().value!);
  } else {
    st.playbacks.delete(key);
    st.playbacks.set(key, p);
  }
  p.lastAt = now;
  // Une lecture qui passe à une autre version (fichier remplacé, nouvelle liste) garde son relevé.
  p.version = init.version;
  return p;
}

export function noteRequest(p: PlaybackStats, kind: RequestKind): void {
  p.requests[kind] += 1;
}

export function noteBuilt(p: PlaybackStats, facts: { video: boolean; n: number; buildMs: number; waitMs: number; diskMs: number; reused: boolean; falseKey?: boolean }): void {
  if (facts.falseKey && !facts.reused) p.falseKeys += 1;
  if (facts.video) {
    p.lastVideoN = facts.n;
    p.maxVideoN = Math.max(p.maxVideoN ?? facts.n, facts.n);
  }
  if (facts.reused) {
    p.reused += 1;
    return;
  }
  p.buildMs += facts.buildMs;
  p.buildMaxMs = Math.max(p.buildMaxMs, facts.buildMs);
  p.waitMs += facts.waitMs;
  p.waitMaxMs = Math.max(p.waitMaxMs, facts.waitMs);
  p.diskMs += facts.diskMs;
}

function convOf(p: PlaybackStats): ConvStats {
  return (p.conv ??= { segments: 0, built: 0, ram: 0, disk: 0, shared: 0, convMs: 0, convMaxMs: 0, feedMs: 0, waitMs: 0, waitMaxMs: 0, busy: 0 });
}

/** Un segment son converti remis (§161) : d'où il vient, et ce qu'il a coûté. */
export function noteConverted(p: PlaybackStats, facts: { from: "ram" | "disk" | "built" | "shared"; convMs: number; feedMs: number; waitMs: number }): void {
  const c = convOf(p);
  c.segments += 1;
  c[facts.from] += 1;
  if (facts.from === "built") {
    c.convMs += facts.convMs;
    c.convMaxMs = Math.max(c.convMaxMs, facts.convMs);
    c.feedMs += facts.feedMs;
  }
  c.waitMs += facts.waitMs;
  c.waitMaxMs = Math.max(c.waitMaxMs, facts.waitMs);
}

/** Un segment son converti refusé « occupé » (file pleine, budget de 8 s dépassé). */
export function noteConvertBusy(p: PlaybackStats): void {
  convOf(p).busy += 1;
}

export function noteSent(p: PlaybackStats, facts: { kind: "segment" | "init"; video: boolean; bytes: number; sendMs: number; aborted: boolean; track?: number }): void {
  if (facts.aborted) {
    p.aborted += 1;
    return;
  }
  p.bytes += facts.bytes;
  p.sendMs += facts.sendMs;
  p.sendMaxMs = Math.max(p.sendMaxMs, facts.sendMs);
  if (facts.kind === "segment") {
    if (facts.video) p.video += 1;
    else {
      p.audio += 1;
      if (facts.track !== undefined) p.audioByTrack[facts.track] = (p.audioByTrack[facts.track] ?? 0) + 1;
    }
  }
}

/**
 * Une ligne de la trace d'une lecture (`trace`), bornée à `TRACE_ENTRIES` : `+12.3s v/41.m4s b23 w0 e45 k8123`
 * — l'instant où le dernier octet a été remis au réseau, depuis la première requête ; construction, attente
 * dans la file, envoi (ms) ; et depuis l'étape 3c le poids remis (`k`, en Ko) : combien d'octets Safari a
 * voulus avant de reprendre après un saut se lit alors sans reconstruire les segments.
 */
export function noteTrace(
  p: PlaybackStats,
  entry: { name: string; buildMs: number; waitMs: number; sendMs: number; reused: boolean; aborted: boolean; bytes?: number },
  now = Date.now()
): void {
  const at = ((now - p.firstAt) / 1000).toFixed(1);
  const flags = `${entry.reused ? " p" : ""}${entry.aborted ? " x" : ""}`;
  const size = entry.bytes !== undefined ? ` k${Math.round(entry.bytes / 1024)}` : "";
  p.trace.push(`+${at}s ${entry.name} b${Math.round(entry.buildMs)} w${Math.round(entry.waitMs)} e${Math.round(entry.sendMs)}${size}${flags}`);
  if (p.trace.length > TRACE_ENTRIES) p.trace.splice(0, p.trace.length - TRACE_ENTRIES);
}

export function noteRefused(p: PlaybackStats, kind: "busy" | "stale" | "error", code?: string): void {
  if (kind === "busy") p.busy += 1;
  else if (kind === "stale") p.stale += 1;
  else {
    p.errors += 1;
    p.lastError = (code ?? "erreur").slice(0, 80);
  }
}

/** Le relevé brut d'une lecture, ou null (jamais vue, oubliée, ou d'un autre compte). */
export function lumenPlaybackStats(s: string, user: string): PlaybackStats | null {
  return state().playbacks.get(`${user}\u0000${s}`) ?? null;
}

/**
 * Ce que l'étape 4 ajoutera à une ligne `stop`, `stall`, `error` ou `fallback` de player.log : des
 * champs plats sous `srv.`, à côté des `diag.*` de la page. Vide si le serveur n'a rien vu de cette
 * lecture pour ce compte — la ligne part alors sans eux, jamais avec des zéros trompeurs.
 */
export function lumenPlaybackFields(s: string, user: string, now = Date.now()): Record<string, number | string> {
  const p = lumenPlaybackStats(s, user);
  if (!p) return {};
  const fields: Record<string, number | string> = {
    "srv.req": p.requests.master + p.requests.playlist + p.requests.init + p.requests.segment,
    "srv.segV": p.video,
    "srv.segA": p.audio,
    "srv.MB": Math.round(p.bytes / 10_000) / 100,
    "srv.buildMs": p.buildMs,
    "srv.buildMaxMs": p.buildMaxMs,
    "srv.waitMaxMs": p.waitMaxMs,
    "srv.diskMs": p.diskMs,
    "srv.sendMaxMs": p.sendMaxMs,
    "srv.firstAgoS": Math.round((now - p.firstAt) / 1000),
    "srv.lastAgoS": Math.round((now - p.lastAt) / 1000),
  };
  // Les compteurs d'incident ne paraissent que s'ils sont arrivés : une ligne lisible d'un coup d'œil.
  if (p.reused) fields["srv.reused"] = p.reused;
  if (p.aborted) fields["srv.aborted"] = p.aborted;
  if (p.busy) fields["srv.busy"] = p.busy;
  if (p.stale) fields["srv.stale"] = p.stale;
  if (p.falseKeys) fields["srv.falseKeys"] = p.falseKeys;
  if (p.errors) {
    fields["srv.errors"] = p.errors;
    if (p.lastError) fields["srv.lastError"] = p.lastError;
  }
  if (p.lastVideoN !== null) fields["srv.lastN"] = p.lastVideoN;
  // La conversion du son (§161), seulement si la lecture en a demandé : nombre, fabriqués / mémoire / disque,
  // temps de ffmpeg (somme, pire), pire attente, « occupé ».
  if (p.conv) {
    fields["srv.convSeg"] = p.conv.segments;
    fields["srv.convBuilt"] = p.conv.built;
    if (p.conv.ram) fields["srv.convRam"] = p.conv.ram;
    if (p.conv.disk) fields["srv.convDisk"] = p.conv.disk;
    if (p.conv.shared) fields["srv.convShared"] = p.conv.shared;
    fields["srv.convMs"] = p.conv.convMs;
    fields["srv.convMaxMs"] = p.conv.convMaxMs;
    fields["srv.convWaitMaxMs"] = p.conv.waitMaxMs;
    if (p.conv.busy) fields["srv.convBusy"] = p.conv.busy;
  }
  return fields;
}

/**
 * La page de banc demande la chronologie de la lecture `s` (route `chrono`, à la synchronisation des horloges,
 * avant la première requête de Safari) : à partir de là, chaque requête de cette lecture y est notée.
 */
export function markChrono(s: string, init: { user: string; itemId: string }, now = Date.now()): PlaybackStats {
  const p = playbackOf(s, { ...init, version: "" }, now);
  p.chrono ??= [];
  return p;
}

/** Une requête de plus dans la chronologie, ou null si la lecture n'est pas chronométrée. L'appelant la complète. */
export function chronoEntry(p: PlaybackStats, name: string, at: number): ChronoEntry | null {
  if (!p.chrono) return null;
  const entry: ChronoEntry = { name: name.slice(0, 40), at };
  p.chrono.push(entry);
  if (p.chrono.length > CHRONO_ENTRIES) p.chrono.splice(0, p.chrono.length - CHRONO_ENTRIES);
  return entry;
}

/** La chronologie de la lecture `s` pour ce compte, ou null. */
export function lumenChronoOf(s: string, user: string): ChronoEntry[] | null {
  const p = lumenPlaybackStats(s, user);
  return p?.chrono ? p.chrono.map((e) => ({ ...e })) : null;
}

/** Pour les tests. */
export function forgetLumenPlaybacks(): void {
  state().playbacks.clear();
}
