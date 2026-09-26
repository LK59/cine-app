import type { QbTorrent } from "@/lib/clients/qbittorrent";

/**
 * L'origine d'une annonce de tracker, sans son chemin : `https://tracker.example/` et non
 * `https://tracker.example/<passkey>/announce`. Chaîne vide si ce n'est pas une URL.
 */
export function trackerOrigin(tracker: unknown): string {
  if (typeof tracker !== "string" || !tracker) return "";
  try {
    const u = new URL(tracker);
    // Schéma et hôte (port compris), sans identifiants ni chemin — pas `origin`, qui vaut
    // « null » pour `udp:` : les trackers publics en UDP auraient disparu du filtre de la page,
    // qui n'en lit que le nom d'hôte.
    return u.host ? `${u.protocol}//${u.host}/` : "";
  } catch {
    return "";
  }
}

const PUBLIC_TORRENT_FIELDS = [
  "hash", "name", "state", "progress", "dlspeed", "upspeed", "size", "eta", "category", "tracker",
  "ratio", "added_on", "uploaded", "downloaded", "content_path", "num_seeds", "num_leechs",
] as const satisfies readonly (keyof QbTorrent)[];

/**
 * Ce qu'un torrent montre au navigateur : les champs de `QbTorrent` — tout ce que la page et sa
 * fiche lisent, le type l'assure — et rien d'autre.
 *
 * `/api/v2/torrents/info` était renvoyé brut, à tout compte connecté : `magnet_uri` et `tracker`
 * y portent l'URL d'annonce complète, passkey du tracker privé comprise — de quoi télécharger
 * au nom de la maison sur ce tracker, et la faire bannir (26/09/2026). La page ne lisait du
 * tracker que son nom d'hôte (filtre « tracker »), que l'origine suffit à donner. Le serveur,
 * lui, continue de lire le torrent entier (`getTorrents`) : seul ce qui sort est réduit.
 */
export function publicTorrent(t: QbTorrent): QbTorrent {
  const out = {} as Record<string, unknown>;
  for (const key of PUBLIC_TORRENT_FIELDS) out[key] = t[key];
  out.tracker = trackerOrigin(t.tracker);
  return out as unknown as QbTorrent;
}
