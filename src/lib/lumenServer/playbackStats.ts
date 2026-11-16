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
   * Les derniers segments remis, du plus ancien au plus récent : `+12.3s v/41 b23 w0 e45`
   * (depuis la première requête, nom, construction, attente dans la file, envoi), `p` s'il était
   * préparé ou partagé, `x` si l'envoi a été coupé. Voir `TRACE_ENTRIES`.
   */
  trace: string[];
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
      trace: [],
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
  return fields;
}

/** Pour les tests. */
export function forgetLumenPlaybacks(): void {
  state().playbacks.clear();
}
