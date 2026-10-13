import { HttpError } from "@/lib/http";

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

/**
 * Le code d'un refus de Jellyseerr à une demande, posé sur l'erreur qui remonte.
 *
 * `fetchJson` lève « 409 Conflict: {"message":"Request for this media already exists."} » : une
 * phrase faite pour le journal, que l'écran affichait telle quelle — en anglais technique aux
 * comptes français, et sans rien de lisible aux autres (13/10/2026). 409 dit « déjà demandé »,
 * 403 avec « quota » dit le quota (« Movie Quota exceeded. »), tout autre 4xx un refus. Un 401 —
 * la clé ou le cookie refusés — n'est pas un refus de la demande et reste sans code. L'erreur est
 * rendue telle quelle, message compris : seul l'écran change.
 */
export function withRequestRefusalCode(err: unknown): unknown {
  if (!(err instanceof HttpError) || err.code) return err;
  const { status } = err;
  if (status === 409) err.code = "request_duplicate";
  else if (status === 403 && /quota/i.test(err.message)) err.code = "request_quota";
  else if (status >= 400 && status < 500 && status !== 401) err.code = "request_refused";
  return err;
}
