/**
 * Une demande que Jellyseerr a refusée (4xx) — déjà demandée, quota atteint, droits — et non une
 * panne. Les pages Radarr et Sonarr de la gestion la cachaient derrière une recherche directe et un
 * message « demandé » (08/10/2026) ; elle se dit désormais, avec le message du serveur.
 */
export class RequestRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RequestRefused";
  }
}

/** Le message d'erreur d'une réponse refusée, s'il y en a un. */
export async function refusalMessage(res: Response): Promise<string> {
  const body = (await res.json().catch(() => null)) as { error?: unknown; message?: unknown } | null;
  const message = typeof body?.error === "string" ? body.error : typeof body?.message === "string" ? body.message : "";
  return message.trim();
}
