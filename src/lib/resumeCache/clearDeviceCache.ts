import { clearPersistedCache } from "@/lib/persistentCache";
import { clearResumeStore } from "./store";

/**
 * « Vider le cache » (panneau Compte, 28/09/2026) : ce que l'application garde sur l'appareil pour
 * aller plus vite — les octets de reprise et d'ouverture (OPFS) et le catalogue de la dernière
 * visite (IndexedDB). Rien n'est perdu : tout se relit au réseau, le catalogue à la prochaine
 * ouverture, les octets au prochain passage d'arrière-plan. Le code de l'application (le cache du
 * service worker) reste : le vider ne libérerait presque rien et coûterait un téléchargement complet.
 *
 * Ne lève jamais.
 */
export async function clearDeviceCache(): Promise<void> {
  await Promise.all([clearResumeStore().catch(() => {}), clearPersistedCache().catch(() => {})]);
}

/** L'espace que le site occupe sur l'appareil, selon le navigateur — ou null s'il ne le dit pas. */
export async function deviceCacheUsage(): Promise<number | null> {
  try {
    const estimate = await navigator.storage?.estimate?.();
    return typeof estimate?.usage === "number" ? estimate.usage : null;
  } catch {
    return null;
  }
}
