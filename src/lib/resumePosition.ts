import { positionUnknownAnswer } from "@/lib/playbackPrefetch";
import { isUpstreamUnreachable, withCode } from "@/lib/upstreamError";

/**
 * D'où part une lecture — la décision, écrite une fois.
 *
 * Deux moitiés, parce qu'elle se prend en deux temps et à deux endroits :
 *
 * - **l'appelant** (un bouton, une fiche) dit ce qu'il sait : `resumeAtFor` ;
 * - **le lecteur** comble ce que l'appelant ignorait : `resolveResumeAt`.
 *
 * Le contrat entre les deux est celui de `PlaybackSession.resumeAt` : un nombre — zéro compris —
 * est une affirmation ; un champ absent veut dire « je ne sais pas, demande au serveur ». Ils ne
 * sont pas interchangeables, et les traiter comme tels a coûté deux bugs opposés le même jour.
 */

const TICKS_PER_SECOND = 10_000_000;

/**
 * La position qu'un appelant peut affirmer.
 *
 * `known` doit vouloir dire « le serveur a répondu », pas « la requête est revenue ». La route de
 * progression revient avec `known: false` et `resumeTicks: null` quand Jellyfin n'a pas répondu ;
 * les deux fiches de film lisaient alors `progress !== undefined`, prenaient ce silence pour
 * « aucune reprise », lançaient à zéro — et les rapports de progression du lecteur écrasaient
 * aussitôt, chez Jellyfin, la position qu'on voulait justement reprendre.
 */
export function resumeAtFor(options: {
  /** « Recommencer » : toujours zéro, et c'est la seule affirmation qui n'a besoin de rien savoir. */
  fromStart?: boolean;
  known: boolean;
  resumeTicks: number | null | undefined;
}): number | undefined {
  if (options.fromStart) return 0;
  if (!options.known) return undefined;
  return options.resumeTicks && options.resumeTicks > 0 ? options.resumeTicks / TICKS_PER_SECOND : 0;
}

/**
 * Ce que le lecteur fait d'un champ absent : il demande.
 *
 * Le lecteur natif le faisait depuis le début, en lisant `playback-state` avant d'ouvrir. Le
 * lecteur stable, lui, traitait l'absence comme un zéro — `if (resumeAt) …` — donc « demande au
 * serveur » y voulait dire « repars du début ». Même garde que le natif : huit secondes, puis le
 * début, ce qui vaut mieux qu'un film qui ne s'ouvre pas.
 */
export async function resolveResumeAt(itemId: string, resumeAt: number | undefined): Promise<number> {
  if (typeof resumeAt === "number") return resumeAt;
  try {
    const response = await fetch(`/api/jellyfin/playback-state/${itemId}`, { signal: AbortSignal.timeout(8000) });
    // Jellyfin injoignable (14/10/2026, §92) : la position est inconnue, et ouvrir au début ferait
    // effacer la reprise par les rapports de progression. L'erreur nommée remonte au lecteur, qui
    // le dit au lieu d'ouvrir.
    if (await positionUnknownAnswer(response)) throw withCode(new Error("position de reprise inconnue : Jellyfin ne répond pas"), "upstream_unreachable");
    if (!response.ok) return 0;
    const state = (await response.json()) as { resumeSeconds?: unknown } | null;
    return typeof state?.resumeSeconds === "number" && state.resumeSeconds > 0 ? state.resumeSeconds : 0;
  } catch (error) {
    if (isUpstreamUnreachable(error)) throw error;
    return 0;
  }
}
