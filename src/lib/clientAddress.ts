import { headers } from "next/headers";

/**
 * L'adresse de la personne derrière une requête, telle que le relais l'a vue.
 *
 * Le relais *ajoute* sa propre observation au bout de `X-Forwarded-For` au lieu de remplacer
 * l'en-tête : la première entrée est celle que le client a bien voulu écrire, la dernière celle
 * du relais qui nous parle — la seule qui vaille pour un déploiement à un saut. Voir `getClientIp`.
 *
 * Refusée si elle ne ressemble pas à une adresse : elle repart vers Jellyfin dans un en-tête, et
 * rien de ce qui vient d'une requête ne doit y entrer sans être regardé.
 */
export function lastForwardedAddress(header: string | null): string | null {
  if (!header) return null;
  const last = header.split(",").map((p) => p.trim()).filter(Boolean).at(-1);
  return last && last.length <= 45 && /^[0-9a-fA-F.:]+$/.test(last) ? last : null;
}

/**
 * L'en-tête qui dit à Jellyfin pour qui l'appel est fait.
 *
 * Sans lui, Jellyfin voyait toutes les connexions et toutes les lectures venir de l'adresse du
 * conteneur sur le réseau Docker (172.20.0.13) — dans son journal d'activité, ses sessions, ses
 * appareils (23/09/2026). Jellyfin ne lit cet en-tête que d'un relais qu'il connaît : le réseau
 * Docker figure dans ses `KnownProxies`, et c'est ce réglage-là qui le rend lisible.
 *
 * Seulement pour les appels faits au nom d'une personne — connexion, lecture, son compte. Les
 * appels de la clé d'administration servent tout le monde à travers les caches : leur prêter
 * l'adresse de celui qui a manqué le cache serait faux.
 *
 * Vide hors d'une requête (tâches de fond, tests) : `headers()` n'existe que dans une requête.
 */
export async function forwardedFor(): Promise<Record<string, string>> {
  try {
    const address = lastForwardedAddress((await headers()).get("x-forwarded-for"));
    return address ? { "X-Forwarded-For": address } : {};
  } catch {
    return {};
  }
}
