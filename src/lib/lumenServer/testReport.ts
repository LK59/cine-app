// La ligne `kind: "lumen-test"` de startup.log : ce que la page de banc `/lumen-test` a mesuré sur un
// appareil, et ce que le serveur a vu des mêmes lectures (étape 3b de docs/remux-serveur/, §157).
//
// Pourquoi une ligne : la page lit du HLS natif, et Safari tire lui-même listes et segments — rien de ce
// qu'il fait entre deux évènements de `<video>` n'est visible de la page. Le serveur, lui, voit chaque
// segment (`playbackStats.ts`). Une ligne réunit les deux, par lecture (`s`) : le temps jusqu'à la
// première image, chaque saut et son attente, les blocages, les erreurs, les pistes audio que Safari
// annonce et ce qu'un changement de piste a fait — et, en face, les segments remis, leur construction,
// leur envoi, et quels segments Safari a demandés après chaque saut (la trace).
//
// Le corps vient du navigateur : tout est relu, borné, et ce qui n'a pas la forme attendue tombe. Le
// compte vient de la session, jamais du corps ; le relevé serveur d'une lecture n'est joint que s'il
// appartient à ce compte (`lumenPlaybackStats`).

import { lumenPlaybackFields, lumenPlaybackStats, isPlaybackId } from "./playbackStats";
import { LUMEN_CUT_MODES } from "./format";

const MAX_RUNS = 12;
const MAX_SEEKS = 80;
const MAX_LOG = 150;

const num = (value: unknown, max = 1e9): number | null =>
  typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= max ? Math.round(value * 1000) / 1000 : null;
const text = (value: unknown, max: number): string | null => (typeof value === "string" ? value.slice(0, max) : null);
const bool = (value: unknown): boolean | null => (typeof value === "boolean" ? value : null);
const list = (value: unknown, max: number): unknown[] => (Array.isArray(value) ? value.slice(0, max) : []);
const obj = (value: unknown): Record<string, unknown> => (value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {});

/** Les seuls champs gardés d'un objet, chacun par sa propre règle ; les absents ne paraissent pas. */
function pick(raw: unknown, rules: Record<string, (value: unknown) => unknown>): Record<string, unknown> {
  const source = obj(raw);
  const out: Record<string, unknown> = {};
  for (const [key, rule] of Object.entries(rules)) {
    const value = rule(source[key]);
    if (value === null || value === undefined) continue;
    // Une liste vide ou un objet sans champ gardé ne dit rien : la ligne reste lisible d'un coup d'œil.
    if (Array.isArray(value) ? value.length === 0 : typeof value === "object" && Object.keys(value).length === 0) continue;
    out[key] = value;
  }
  return out;
}

const SEEK_KINDS = new Set(["-10", "+10", "+60", "hasard", "parcours", "barre", "depart"]);
const HEARD = new Set(["oui", "non"]);

function seekOf(raw: unknown): Record<string, unknown> {
  return pick(raw, {
    kind: (v) => (typeof v === "string" && SEEK_KINDS.has(v) ? v : null),
    from: (v) => num(v, 1e6),
    to: (v) => num(v, 1e6),
    // Du geste à `seeked`, à la première avance du temps, à `playing` ; et ce qui a manqué.
    seekedMs: (v) => num(v, 1e7),
    advanceMs: (v) => num(v, 1e7),
    playingMs: (v) => num(v, 1e7),
    landed: (v) => num(v, 1e6),
    ok: bool,
    timedOut: bool,
    waits: (v) => num(v, 1e4),
    error: (v) => text(v, 160),
  });
}

function runOf(raw: unknown, user: string): Record<string, unknown> {
  const run = pick(raw, {
    itemId: (v) => (typeof v === "string" && /^[0-9a-f]{32}$/i.test(v) ? v : null),
    title: (v) => text(v, 120),
    cut: (v) => (typeof v === "string" && (LUMEN_CUT_MODES as readonly string[]).includes(v) ? v : null),
    audio: (v) => num(v, 1e4),
    s: (v) => (isPlaybackId(v) ? v : null),
    version: (v) => text(v, 40),
    verdict: (v) =>
      pick(v, {
        ok: bool,
        reason: (x) => text(x, 40),
        detail: (x) => text(x, 120),
        segments: (x) => num(x, 1e6),
        longestS: (x) => num(x, 1e5),
        targetS: (x) => num(x, 1e5),
        craRasl: (x) => num(x, 1e6),
        verified: (x) => num(x, 1e6),
        durationS: (x) => num(x, 1e6),
      }),
    loadedMetadataMs: (v) => num(v, 1e7),
    firstFrameMs: (v) => num(v, 1e7),
    firstFrameVia: (v) => (v === "rvfc" || v === "playing" ? v : null),
    playedS: (v) => num(v, 1e6),
    seeks: (v) => list(v, MAX_SEEKS).map(seekOf),
    waits: (v) => pick(v, { count: (x) => num(x, 1e5), totalMs: (x) => num(x, 1e8), maxMs: (x) => num(x, 1e8) }),
    errors: (v) => list(v, 10).map((x) => text(x, 200)).filter((x) => x !== null),
    audioTracks: (v) => list(v, 16).map((x) => text(x, 160)).filter((x) => x !== null),
    audioSwitches: (v) =>
      list(v, 12).map((x) =>
        pick(x, {
          from: (y) => text(y, 80),
          to: (y) => text(y, 80),
          // Du changement au temps qui a avancé de 0,3 s (≈ 300 ms sans coupure) ; `reloaded` : l'élément a-t-il
          // tout rechargé (`emptied`/`loadstart`) ; `waited` : un `waiting` entre-temps ; `heard` : ce que
          // l'administrateur a entendu, à la main. Les segments son demandés, eux, sont dans `srv.audioByTrack`.
          ms: (y) => num(y, 1e7),
          reloaded: bool,
          changeEvent: bool,
          waited: bool,
          heard: (y) => (typeof y === "string" && HEARD.has(y) ? y : null),
        })
      ),
    quality: (v) => pick(v, { total: (x) => num(x, 1e9), dropped: (x) => num(x, 1e9), corrupted: (x) => num(x, 1e9) }),
    end: (v) => text(v, 40),
  });
  // Le relevé serveur de la même lecture, s'il est de ce compte : `srv.*` comme les lignes du lecteur,
  // les segments son par piste, et la trace des segments remis.
  if (typeof run.s === "string") {
    const fields = lumenPlaybackFields(run.s, user);
    const stats = lumenPlaybackStats(run.s, user);
    if (stats) {
      Object.assign(run, fields);
      run["srv.audioByTrack"] = { ...stats.audioByTrack };
      run["srv.trace"] = [...stats.trace];
      run["srv.version"] = stats.version;
    }
  }
  return run;
}

/** Le corps d'un « Envoyer les résultats », relu et borné, avec le relevé serveur de chaque lecture. */
export function lumenTestReport(body: Record<string, unknown>, user: string): Record<string, unknown> {
  return {
    build: text(body.build, 40),
    env: pick(body.env, {
      userAgent: (v) => text(v, 300),
      standalone: bool,
      hlsNative: (v) => text(v, 20),
      managedMediaSource: bool,
      screen: (v) => text(v, 40),
    }),
    runs: list(body.runs, MAX_RUNS).map((run) => runOf(run, user)),
    log: list(body.log, MAX_LOG)
      .map((line) => text(line, 200))
      .filter((line): line is string => line !== null),
  };
}
