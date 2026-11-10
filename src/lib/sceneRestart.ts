/**
 * « Revenir au début de la scène » (DECISIONS.md §143) : à la reprise d'un film laissé depuis des heures, faut-il
 * proposer de revenir au début de la scène en cours, et où ? **Une seule fonction, pure**, lue par les commandes
 * des trois lecteurs (`PlayerControls` : natif, serveur, hors ligne) et par ses tests — elle ne lit ni réseau,
 * ni horloge, ni stockage : tout lui est donné.
 *
 * Les débuts de scène et leur verdict viennent de `laterna-xray` (`xray/app/scenecuts.py`) : `cut.ok` dit si
 * une frontière est un vrai début de scène (chapitre d'auteur, ou couleurs **et** personnes qui changent),
 * `cut.why` pourquoi non (`parole` — au milieu d'un dialogue —, `même-lieu`, `montage`, `îlot`), et `entry` le
 * point d'entrée (reculé jusqu'au début d'une phrase commencée juste avant la coupe).
 *
 * Les règles, dans l'ordre où elles refusent (la raison part au journal, `sceneRestart: "non:<raison>"`) :
 *
 * 1. l'analyse est complète et finie, mesurée (`cut` sur les scènes), et la parole connue ;
 * 2. le titre parle (20 % du temps au moins) : sans dialogues, rien ne dit où une scène commence vraiment ;
 * 3. une absence de 4 h au moins depuis la dernière lecture (Jellyfin, `LastPlayedDate`, gelée à l'ouverture) ;
 * 4. aucun saut ni changement de piste avant la première image ;
 * 5. pas dans la première minute du fichier, ni dans l'intro, le récap, le générique de fin (segments de
 *    Jellyfin) ou les dernières scènes sans visage (le générique que Jellyfin ne connaît pas) ;
 * 6. aucune coupe sûre dans les 20 dernières secondes (la scène vient de commencer : rien à rattraper) ;
 * 7. la cible : la dernière coupe sûre au moins 20 s avant la position, prise à son point d'entrée — de 20 s
 *    à 3 min en arrière ; on peut remonter par-dessus des frontières refusées pour `même-lieu` (le même décor
 *    filmé autrement), jamais par-dessus une autre (une phrase coupée, un îlot, un montage, une frontière sans
 *    verdict) : la scène où l'on revient ne serait plus celle qu'on regardait.
 *
 * Mesuré le 10/11/2026 sur *Ted Lasso* et *Le Flambeau* (R&D, positions tous les 7 s) : avec ces règles, le
 * bouton est proposé à une position sur deux environ, pour un recul médian de 70 à 75 s.
 */

export const SCENE_RESTART_MIN_ABSENCE_MS = 4 * 3600_000;
export const SCENE_RESTART_MIN_BACK_S = 20;
export const SCENE_RESTART_MAX_BACK_S = 180;
export const SCENE_RESTART_MIN_POSITION_S = 60;
export const SCENE_RESTART_MIN_SPEECH_SHARE = 0.2;
/** Le bouton reste ce temps à l'écran, à partir de la première image à la position de reprise. */
export const SCENE_RESTART_SHOWN_MS = 8000;

export interface SceneCut {
  ok: boolean;
  why: string;
}

export interface SceneRestartScene {
  start: number;
  end: number;
  people: readonly unknown[];
  entry?: number;
  cut?: SceneCut;
}

export interface SceneRestartPayload {
  status: string;
  complete: boolean;
  scenes: readonly SceneRestartScene[];
  speechShare?: number | null;
}

export interface SceneRestartInput {
  /** La position de la première image, en secondes. */
  position: number;
  /** L'instant de la décision (ms depuis l'époque). */
  now: number;
  /** La dernière lecture selon Jellyfin, gelée à l'ouverture ; `null`/absente : inconnue. */
  lastPlayedAt: string | null | undefined;
  payload: SceneRestartPayload | null;
  introSkip?: { start: number; end: number } | null;
  recapSkip?: { start: number; end: number } | null;
  creditsStart?: number | null;
  /** Un geste avant la première image : un saut, un changement de piste. */
  interrupted?: "saut" | "piste" | null;
}

export type SceneRestartDecision =
  | { offer: true; target: number; back: number; why: string }
  | { offer: false; reason: string };

const no = (reason: string): SceneRestartDecision => ({ offer: false, reason });

/** Les frontières qu'on peut enjamber en remontant vers la cible : le même décor filmé autrement. */
const CROSSABLE = new Set(["même-lieu"]);

export function decideSceneRestart(input: SceneRestartInput): SceneRestartDecision {
  const { payload, position: p } = input;
  if (!payload || payload.status !== "done" || !payload.complete) return no("analyse-incomplète");
  const scenes = [...payload.scenes].sort((a, b) => a.start - b.start);
  if (!scenes.some((s) => s.cut)) return no("coupes-absentes");
  if (typeof payload.speechShare !== "number") return no("parole-inconnue");
  if (payload.speechShare < SCENE_RESTART_MIN_SPEECH_SHARE) return no("peu-de-parole");
  const last = input.lastPlayedAt ? Date.parse(input.lastPlayedAt) : NaN;
  if (!Number.isFinite(last)) return no("absence-inconnue");
  if (input.now - last < SCENE_RESTART_MIN_ABSENCE_MS) return no("absence-courte");
  if (input.interrupted) return no(input.interrupted);
  if (!Number.isFinite(p) || p < SCENE_RESTART_MIN_POSITION_S) return no("début-du-fichier");
  const inside = (r: { start: number; end: number } | null | undefined) => !!r && p >= r.start && p < r.end;
  if (inside(input.introSkip)) return no("intro");
  if (inside(input.recapSkip)) return no("récap");
  if (typeof input.creditsStart === "number" && p >= input.creditsStart) return no("générique-de-fin");
  // Les dernières scènes sans personne à l'écran : un générique que Jellyfin ne connaît pas.
  let tail = scenes.length;
  while (tail > 0 && scenes[tail - 1].people.length === 0) tail--;
  if (tail < scenes.length && p >= scenes[tail].start) return no("fin-sans-visages");

  const entryOf = (s: SceneRestartScene) => (typeof s.entry === "number" ? s.entry : s.start);
  const sure = scenes.filter((s) => s.cut?.ok === true);
  if (sure.some((s) => entryOf(s) > p - SCENE_RESTART_MIN_BACK_S && entryOf(s) <= p)) return no("scène-récente");
  const candidates = sure.filter((s) => entryOf(s) <= p - SCENE_RESTART_MIN_BACK_S);
  if (!candidates.length) return no("aucune-coupe-sûre");
  const target = candidates.reduce((a, b) => (entryOf(b) > entryOf(a) ? b : a));
  const back = p - entryOf(target);
  if (back > SCENE_RESTART_MAX_BACK_S) return no("trop-loin");
  for (const s of scenes) {
    if (s.start <= target.start || s.start > p) continue;
    if (!s.cut) return no("coupe-inconnue");
    if (!s.cut.ok && !CROSSABLE.has(s.cut.why)) return no(`coupe-${s.cut.why}`);
  }
  return { offer: true, target: entryOf(target), back, why: target.cut?.why ?? "" };
}
