/**
 * Ce que le navigateur prédit de la lecture du fichier ouvert — mesuré, rien n'en dépend
 * (28/10/2026).
 *
 * `MediaSource.isTypeSupported` répond « sais-tu lire ce format ? ». `mediaCapabilities.decodingInfo`
 * répond aussi « sans saccade ? » (`smooth`) et « sans vider la batterie ? » (`powerEfficient`), pour
 * une taille, un débit et un HDR donnés. Si ces réponses prédisent les attentes réellement mesurées
 * (`stop.waits`, `diag.*`), elles pourraient un jour faire proposer la version allégée d'emblée à un
 * appareil qui ne suivra pas ; tant qu'on ne l'a pas vérifié, elles ne font qu'entrer dans la trace
 * de l'ouverture (« capacités : … »), donc dans la ligne `opening`. Une erreur, une API absente : rien.
 */

import type { MatroskaTrack } from "./matroska";
import { trace } from "./trace";

/** Les valeurs Matroska (ISO/IEC 23091-2) que l'API sait nommer. */
const TRANSFER: Record<number, "srgb" | "pq" | "hlg"> = { 1: "srgb", 16: "pq", 18: "hlg" };
const GAMUT: Record<number, "srgb" | "rec2020"> = { 1: "srgb", 9: "rec2020" };

export function probeDecodingInfo(videoMimeType: string, track: MatroskaTrack, sizeBytes: number, durationSeconds: number): void {
  const capabilities = typeof navigator !== "undefined" ? navigator.mediaCapabilities : undefined;
  if (!capabilities?.decodingInfo || !track.video) return;
  const colour = track.video.colour;
  const transferFunction = colour?.transferCharacteristics !== undefined ? TRANSFER[colour.transferCharacteristics] : undefined;
  const colorGamut = colour?.primaries !== undefined ? GAMUT[colour.primaries] : undefined;
  const framerate = track.defaultDurationNs ? 1e9 / track.defaultDurationNs : 24;
  const bitrate = durationSeconds > 0 ? Math.round((sizeBytes * 8) / durationSeconds) : 10_000_000;
  const started = Date.now();
  try {
    capabilities
      .decodingInfo({
        type: "media-source",
        video: {
          contentType: videoMimeType,
          width: track.video.width,
          height: track.video.height,
          bitrate,
          framerate,
          ...(transferFunction ? { transferFunction } : {}),
          ...(colorGamut ? { colorGamut } : {}),
        },
      })
      .then(
        (info) =>
          trace(
            `capacités : ${info.supported ? "lisible" : "illisible"}, ${info.smooth ? "fluide" : "pas fluide"}, ${info.powerEfficient ? "économe" : "pas économe"} (${Date.now() - started} ms)`
          ),
        () => {}
      );
  } catch {
    /* une mesure, pas une décision */
  }
}
