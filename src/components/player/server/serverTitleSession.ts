// L'état « par épisode » du lecteur serveur (audit B4, 23/10/2026, DECISIONS.md §115). Le lecteur
// serveur passe à l'épisode suivant sans être démonté (docs/cycle-de-vie-lecteur.md, « Deux règles de
// montage ») : chaque titre ouvre une séance du journal neuve, et tout ce qui la décrit repart de
// zéro. Un effet de `ActivePlayer` remettait ces références à zéro une par une ; la liste vit ici,
// dans un type — une référence ajoutée à la séance sans sa remise à zéro ne compile plus.
//
// Le lecteur natif n'en a pas besoin : son hôte est remonté à chaque titre (clé `itemId:openId`).
import { SessionTally, newPlayerSessionId } from "@/lib/playerSessionTally";
import { LinkRecovery, SlowLog, StutterWatch } from "@/lib/slowLinkPolicy";
import type { ServerStartWhy } from "@/lib/serverPlayerLog";

/** Ce qu'une séance du lecteur serveur tient pour un titre. */
export interface ServerTitleSession {
  /** Le décompte du bilan (`stop`) — voir `SessionTally`. */
  tally: SessionTally;
  /** Les relances par motif (`restarts` au bilan). */
  restarts: Partial<Record<ServerStartWhy, number>>;
  subtitleSwitches: number;
  /** Une image a joué dans cette séance. */
  played: boolean;
  startedAt: number;
  slowLog: SlowLog;
  stutter: StutterWatch;
  recovery: LinkRecovery;
  lighterCleared: boolean;
}

/** Les références de l'hôte qui portent chaque champ. */
export type ServerTitleRefs = { [K in keyof ServerTitleSession]: { current: ServerTitleSession[K] } };

/** Une séance neuve — construite dans l'ordre où l'effet de l'hôte la construisait. */
export function newServerTitleSession(): ServerTitleSession {
  return {
    tally: new SessionTally(),
    restarts: {},
    subtitleSwitches: 0,
    played: false,
    startedAt: Date.now(),
    slowLog: new SlowLog(),
    stutter: new StutterWatch(),
    recovery: new LinkRecovery(),
    lighterCleared: false,
  };
}

/**
 * Un autre titre : une séance du journal neuve (son identifiant d'abord, comme avant), et chaque
 * référence de `refs` remise à sa valeur de départ.
 */
export function startServerTitleSession(
  itemId: string,
  logSession: { current: { itemId: string; id: string } },
  refs: ServerTitleRefs
): void {
  logSession.current = { itemId, id: newPlayerSessionId() };
  const fresh = newServerTitleSession();
  for (const key of Object.keys(fresh) as (keyof ServerTitleSession)[]) {
    (refs[key] as { current: unknown }).current = fresh[key];
  }
}
