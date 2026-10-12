// Les séances Jellyfin ouvertes par un préchauffage de version allégée (DECISIONS.md §78), retenues par
// compte : la route d'arrêt `prewarm` ne coupe que celles-là. Sans ce registre, elle arrêtait le
// transcodage de n'importe quel couple appareil / séance qu'on lui tendait — à la clé d'administration,
// donc celui d'un autre compte aussi.
//
// En mémoire, bornées et oubliées seules : une séance de préchauffage vit au plus le temps d'une ouverture
// ou d'une bascule. Un redémarrage les oublie — Jellyfin arrête de lui-même, plus tard, un transcodage
// que personne ne lit.

const KEEP_MS = 15 * 60_000;
const MAX = 500;

const sessions = new Map<string, { deviceId: string; at: number }>();

const keyOf = (jfId: string, playSessionId: string) => `${jfId}\n${playSessionId}`;

/** Un préchauffage vient d'ouvrir cette séance pour ce compte, sous cet appareil (celui de son adresse). */
export function notePrewarmSession(jfId: string, playSessionId: string, deviceId: string, now = Date.now()): void {
  for (const [key, entry] of sessions) {
    if (now - entry.at > KEEP_MS || sessions.size >= MAX) sessions.delete(key);
    else break;
  }
  sessions.set(keyOf(jfId, playSessionId), { deviceId, at: now });
}

/**
 * La séance est-elle un préchauffage de ce compte, sous cet appareil ? Vrai une fois : elle est alors
 * retirée du registre (l'arrêt est demandé).
 */
export function takePrewarmSession(jfId: string, playSessionId: string, deviceId: string, now = Date.now()): boolean {
  const key = keyOf(jfId, playSessionId);
  const entry = sessions.get(key);
  if (!entry || now - entry.at > KEEP_MS || entry.deviceId !== deviceId) return false;
  sessions.delete(key);
  return true;
}

/** Pour les tests. */
export function forgetPrewarmSessions(): void {
  sessions.clear();
}
