/**
 * Les sous-titres d'un passage rejoué (DECISIONS.md §150, 13/11/2026).
 *
 * Pourquoi : un recul de dix secondes veut presque toujours dire « je n'ai pas compris ce qu'il a dit » —
 * 1 296 des 7 249 sauts de `player.log`, souvent deux ou trois d'affilée. Comme sur l'Apple TV, le passage
 * rejoué s'affiche alors sous-titré, puis les sous-titres s'en vont d'eux-mêmes une fois revenu là où l'on
 * était. Pour tous, sans réglage : rien n'est demandé au serveur, rien n'est enregistré.
 *
 * Les règles, toutes ici et nulle part ailleurs — les trois lecteurs (natif, serveur, hors ligne) n'en
 * gardent que l'affichage :
 *
 * - **Déclencheur** : un recul court (`isReplayRewind` : le bouton −10, la flèche ←, le recul de l'écran
 *   verrouillé), **film en lecture**. Un recul en pause sert d'abord à revoir une image ; un saut plus long
 *   ou la barre, c'est naviguer, pas réécouter.
 * - **Seulement sans sous-titre complet à l'écran** : aucun, ou une piste forcée (qui ne traduit que les
 *   panneaux et les répliques étrangères, presque jamais la phrase manquée). Jamais avec un second
 *   sous-titre (§87), jamais pendant une diffusion (le téléviseur garde celui incrusté au lancement).
 * - **La piste** (`pickReplaySubtitle`) : une piste complète en texte — jamais forcée, jamais en image —,
 *   dans la langue de la forcée affichée (VO avec forcés français : l'aide en français), sinon dans celle
 *   de l'audio entendu (on lit les mots qu'on entend), sinon dans celle du compte ; sinon rien, et rien
 *   n'est montré. Mesuré sur 10 487 films et épisodes le 13/11/2026 : 93,6 % ont la langue de leur audio,
 *   2,5 % prennent celle du compte, 3,9 % rien.
 * - **La durée** : le passage rejoué, pas un minuteur — de la cible du recul jusqu'à la position d'avant
 *   le **premier** recul, plus deux secondes (`REPLAY_TAIL_S`) ; chaque recul de plus pendant l'aide
 *   allonge d'autant. Tout autre saut, un choix dans le menu ou la fin de la séance y mettent fin.
 * - **Jamais un choix** : ni préférence, ni `subtitleSwitches`, ni piste reprise à l'épisode suivant.
 *   Toucher la pastille en fait un vrai choix, compté comme tel.
 */
import { isForcedTrack, trackLanguage, normaliseLanguage, type NamedTrack } from "@/lib/trackPreferences";

/** Après la position d'avant le premier recul : le temps de lire la fin de la phrase. */
export const REPLAY_TAIL_S = 2;

/** Un recul « pour réécouter » : de cinq à quinze secondes en arrière (−10 partout, d'autres pas au verrouillage). */
export function isReplayRewind(deltaSeconds: number): boolean {
  return deltaSeconds <= -5 && deltaSeconds >= -15;
}

export interface ReplayCandidate extends NamedTrack {
  id: number;
  /** Du texte que ce lecteur sait dessiner — une piste en image (PGS, VobSub) n'en est jamais une. */
  text: boolean;
  isHearingImpaired?: boolean;
}

export interface ReplayPickInput {
  tracks: readonly ReplayCandidate[];
  /** La piste à l'écran, ou `null`. Une piste inconnue de `tracks` (une génération en cours) : rien. */
  current: number | null;
  /** Le second sous-titre (§87), ou `null`. */
  second?: number | null;
  /** La langue de l'audio entendu (code du conteneur ou de Jellyfin). */
  audioLanguage: string | null;
  /** La langue des sous-titres du compte, puis celle de l'interface : le repli, dans cet ordre. */
  accountLanguages: readonly (string | null | undefined)[];
}

/** La piste à montrer pendant un passage rejoué, ou `null` : rien à montrer, ou déjà un complet à l'écran. */
export function pickReplaySubtitle(input: ReplayPickInput): number | null {
  const { tracks, current } = input;
  if (input.second != null) return null;
  let forcedLanguage: string | null = null;
  if (current !== null) {
    const shown = tracks.find((track) => track.id === current);
    // Un complet déjà à l'écran : il n'y a rien à aider. Une piste qu'on ne connaît pas (une génération) :
    // on ne sait pas ce qu'elle est, on n'y touche pas.
    if (!shown || !isForcedTrack(shown)) return null;
    forcedLanguage = trackLanguage(shown);
  }
  const full = tracks.filter((track) => track.text && !isForcedTrack(track));
  const wanted = [forcedLanguage, normaliseLanguage(input.audioLanguage), ...input.accountLanguages.map(normaliseLanguage)];
  for (const language of wanted) {
    if (!language) continue;
    const inLanguage = full.filter((track) => trackLanguage(track) === language);
    if (!inLanguage.length) continue;
    // Une piste ordinaire d'abord (la malentendants décrit aussi les bruits), puis celle que le fichier marque
    // par défaut, puis l'ordre du fichier.
    const ranked = [...inLanguage].sort(
      (a, b) => Number(!!a.isHearingImpaired) - Number(!!b.isHearingImpaired) || Number(b.isDefault) - Number(a.isDefault)
    );
    return ranked[0].id;
  }
  return null;
}

/** La fenêtre d'aide en cours : jusqu'où montrer la piste `track`. */
export interface ReplayWindow {
  track: number;
  until: number;
}

/**
 * Un recul pour réécouter, de `from` : la fenêtre ouverte, ou allongée — la fin reste la plus lointaine des
 * positions d'avant recul, plus `REPLAY_TAIL_S`. `null` : rien à ouvrir (pas de piste, et rien d'ouvert).
 */
export function extendReplayWindow(open: ReplayWindow | null, track: number | null, from: number): ReplayWindow | null {
  const until = from + REPLAY_TAIL_S;
  if (open) return { track: open.track, until: Math.max(open.until, until) };
  if (track === null) return null;
  return { track, until };
}

// --- Le relevé, porté par le bilan `stop` -------------------------------------------------------------------

/**
 * Par élément, comme `xrayUsage.ts` : une reconstruction du lecteur natif ou un passage au lecteur serveur
 * remonte les commandes sans finir la séance. Deux compteurs : les aides montrées, et celles que la personne a
 * gardées (la pastille touchée). **Rien tant qu'aucune aide n'a paru** : le bilan reste identique au mot près,
 * et les empreintes du lecteur ne le voient pas.
 */
interface Usage {
  shown: number;
  kept: number;
  ended: boolean;
}

const usages = new Map<string, Usage>();
const MAX_SESSIONS = 20;
const MAX_COUNT = 999;

function usageOf(itemId: string): Usage {
  const known = usages.get(itemId);
  if (known && !known.ended) return known;
  const fresh: Usage = { shown: 0, kept: 0, ended: false };
  usages.delete(itemId);
  usages.set(itemId, fresh);
  while (usages.size > MAX_SESSIONS) usages.delete(usages.keys().next().value as string);
  return fresh;
}

/** Une aide a paru (une fenêtre ouverte — l'allonger n'en compte pas une autre). */
export function noteReplayShown(itemId: string): void {
  const usage = usageOf(itemId);
  usage.shown = Math.min(MAX_COUNT, usage.shown + 1);
}

/** La pastille touchée : les sous-titres gardés pour de bon. */
export function noteReplayKept(itemId: string): void {
  const usage = usageOf(itemId);
  usage.kept = Math.min(MAX_COUNT, usage.kept + 1);
}

/** Le champ du bilan : `replaySubs: "a3 g1"` (aides, gardées), absent tant qu'aucune n'a paru. */
export function replayLogFields(itemId: string): { replaySubs?: string } {
  const usage = usages.get(itemId);
  if (!usage || usage.ended || usage.shown === 0) return {};
  return { replaySubs: `a${usage.shown} g${usage.kept}` };
}

/** La ligne `stop` est partie : la prochaine ouverture de l'élément repart de zéro. */
export function endReplayUsage(itemId: string): void {
  const usage = usages.get(itemId);
  if (usage) usage.ended = true;
}

/** Pour les tests, et à la sortie d'un compte. */
export function forgetReplayUsage(): void {
  usages.clear();
}

/** La forme exacte que le serveur accepte (`playerLog.ts`). */
export const REPLAY_USAGE_VALUE = /^a\d{1,3} g\d{1,3}$/;
