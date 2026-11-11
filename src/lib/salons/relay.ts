/**
 * Où le relais des WebSockets (`server-boot/salonsRelay.mjs`) envoie les connexions des salons (§146).
 *
 * Le relais vit dans le programme de démarrage, hors de Next : il ne lit pas les réglages. L'application lui publie
 * l'adresse du service sous un symbole partagé (même processus) à chaque demande de laissez-passer — c'est-à-dire
 * juste avant chaque connexion. Fonction coupée : rien de publié, le relais refuse.
 */
const RELAY_KEY = Symbol.for("cine-app.salons.relay");

export function publishSalonsRelay(url: string | null): void {
  (globalThis as Record<symbol, unknown>)[RELAY_KEY] = url ? { url } : null;
}

export function salonsRelayTarget(): { url: string } | null {
  return ((globalThis as Record<symbol, unknown>)[RELAY_KEY] as { url: string } | null | undefined) ?? null;
}
