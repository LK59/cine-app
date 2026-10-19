/**
 * Les deux qualités du téléchargement hors ligne (bêta), tranchées par Louis le 19/10/2026 après le
 * test à l'œil des extraits : Standard, 2 Mb/s — Jellyfin choisit alors le 720p — et Haute, 4 Mb/s,
 * le plus bas débit où il garde le 1080p. Lu par le serveur (`jobs.ts`) et par la fenêtre de choix,
 * pour la taille annoncée : ce module n'importe rien du serveur.
 */
export type OfflineQuality = "standard" | "high";
export type OfflineCodec = "hevc" | "h264";

export const OFFLINE_QUALITIES: Record<OfflineQuality, { videoBps: number }> = {
  standard: { videoBps: 2_000_000 },
  high: { videoBps: 4_000_000 },
};
export const OFFLINE_AUDIO_BPS = 128_000;

/** La taille attendue, pour l'avancement et la place : la durée au débit demandé, plus 5 %. */
export function expectedBytes(runtimeSeconds: number, quality: OfflineQuality): number {
  return Math.round(((runtimeSeconds * (OFFLINE_QUALITIES[quality].videoBps + OFFLINE_AUDIO_BPS)) / 8) * 1.05);
}
