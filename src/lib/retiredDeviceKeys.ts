/**
 * Les clés d'appareil (`localStorage`) d'options et d'essais retirés, effacées à chaque lancement.
 *
 * Avant, le panneau Compte effaçait les clés d'essais retirés au prochain réglage de l'option Lumen serveur
 * (17/11/2026). Lumen serveur archivé le même jour (DECISIONS.md §196), plus aucun réglage ne passerait par là :
 * l'option (`cine:lumen-serveur`), le débit retenu par l'appareil (`cine:lumen-debit`), la série choisie sur la page
 * de banc (`cine:lumen-test-serie`) et les deux essais déjà retirés seraient restés sur chaque appareil pour toujours.
 * Effacer une clé absente ne coûte rien ; tout échec de stockage (navigation privée) est ignoré.
 */
export const RETIRED_DEVICE_KEYS = [
  "cine:lumen-serveur",
  "cine:lumen-debit",
  "cine:lumen-test-serie",
  "cine:lumen-reprise-saut",
  "cine:lumen-son-eveille",
] as const;

export function clearRetiredDeviceKeys(storage?: Pick<Storage, "removeItem"> | null): void {
  let target = storage;
  try {
    // L'accès même à `localStorage` peut lever (stockage bloqué) : dans la garde, comme chaque effacement.
    target ??= typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return;
  }
  if (!target) return;
  for (const key of RETIRED_DEVICE_KEYS) {
    try {
      target.removeItem(key);
    } catch {
      // Stockage refusé : rien à effacer qu'on puisse atteindre.
    }
  }
}
