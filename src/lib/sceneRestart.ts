/**
 * « Revenir au début de la scène » (DECISIONS.md §143) : à la reprise d'un film laissé depuis des heures, faut-il
 * proposer de revenir au début de la scène en cours, et où ? **Une seule fonction, pure**, lue par les commandes
 * des trois lecteurs (`PlayerControls` : natif, serveur, hors ligne) et par ses tests — elle ne lit ni réseau,
 * ni horloge, ni stockage : tout lui est donné.
 *
 * Les débuts de scène et leur verdict viennent de `laterna-xray` (`xray/app/scenecuts.py`, `cutsVersion` 2) :
 * `cut.ok` dit si une frontière est un vrai début de scène (début du fichier, après une plage sautée, chapitre
 * d'auteur, ou couleurs **et** personnes qui changent entre deux scènes d'au moins 40 s, sur un temps de silence,
 * avec une réplique dans la minute), `cut.why` pourquoi non (`parole`, `même-lieu`, `montage`, `îlot`, `court`,
 * `muet`, `enchaîné`), `entry` le point d'entrée (reculé jusqu'au début d'une phrase commencée juste avant la
 * coupe), et `pauses` les silences d'au moins 5 s qui suivent une prise de parole, rangés dans la scène où ils
 * commencent.
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
 * 7. la cible : la dernière coupe sûre au moins 20 s avant la position, prise à son point d'entrée, de 20 s à
 *    90 s en arrière — et jamais le début du fichier ni la reprise après une plage sautée (`cible-début`,
 *    `cible-après-saut`) : ce sont des bords de l'analyse, pas des débuts de scène reconnus ;
 * 8. aucune frontière refusée entre la cible et la position, quelle qu'en soit la raison (`coupe-<raison>`), ni
 *    sans verdict : la scène où l'on revient ne serait plus celle qu'on regardait ;
 * 9. aucun silence d'au moins 5 s commencé après le point d'entrée et avant la position (`pause`) : la scène a
 *    changé de temps, sinon de lieu, sans que l'image le dise.
 *
 * Mesuré le 10/11/2026 (R&D, 17 titres, une position toutes les 10 s, cibles jugées à l'œil) : avec une cible
 * jusqu'à 3 min en enjambant les `même-lieu` et les deux signaux de la version 1, le bouton paraissait à une
 * position sur cinq et ne ramenait au bon endroit que deux fois sur trois ; resserré ainsi (service compris),
 * il paraît à 3 ou 4 % des positions, et ne ramène plus à une cible fausse.
 */

export const SCENE_RESTART_MIN_ABSENCE_MS = 4 * 3600_000;
export const SCENE_RESTART_MIN_BACK_S = 20;
export const SCENE_RESTART_MAX_BACK_S = 90;
export const SCENE_RESTART_MIN_POSITION_S = 60;
export const SCENE_RESTART_MIN_SPEECH_SHARE = 0.2;
/** Un silence de cette durée, commencé après le point d'entrée et avant la position, refuse (`pause`). */
export const SCENE_RESTART_MAX_PAUSE_S = 5;
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
  /** Les silences (≥ 5 s, après une prise de parole) qui commencent dans cette scène ; leur fin peut la dépasser. */
  pauses?: readonly (readonly [number, number])[];
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

/**
 * Les coupes sûres qui ne sont jamais des cibles : le début du fichier et la reprise après une plage sautée (un
 * générique d'ouverture) ne disent que l'endroit où l'analyse commence. Elles comptent pourtant comme des débuts
 * de scène pour le reste — une reprise juste après l'une d'elles est une scène récente, et l'on ne remonte pas
 * par-dessus une plage sautée jusqu'à une coupe d'avant le générique.
 */
const NOT_A_TARGET = new Set(["début", "après-saut"]);

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
  const entry = entryOf(target);
  const back = p - entry;
  if (back > SCENE_RESTART_MAX_BACK_S) return no("trop-loin");
  const why = target.cut?.why ?? "";
  if (NOT_A_TARGET.has(why)) return no(`cible-${why}`);
  // De la cible à la position : chaque frontière a un verdict et aucune n'est refusée — rien ne s'enjambe, pas
  // même un « même lieu » (mesuré : enjamber rendait la cible fausse ou trop tôt plus d'une fois sur trois). Chaque scène porte ses silences ; un
  // service d'avant eux (`cutsVersion` 1, deux signaux non resserrés) ne fait rien proposer.
  const span = scenes.filter((s) => s.start >= target.start && s.start <= p);
  for (const s of span) {
    if (s === target) continue;
    if (!s.cut) return no("coupe-inconnue");
    if (!s.cut.ok) return no(`coupe-${s.cut.why}`);
  }
  if (span.some((s) => !Array.isArray(s.pauses))) return no("pauses-inconnues");
  for (const s of span) {
    for (const [start, end] of s.pauses ?? []) {
      if (start > entry && start < p && Math.min(end, p) - start >= SCENE_RESTART_MAX_PAUSE_S) return no("pause");
    }
  }
  return { offer: true, target: entry, back, why };
}
