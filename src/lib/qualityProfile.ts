import { settingValue } from "@/lib/settings/setup";

/**
 * Le profil de qualité d'un ajout à Radarr ou Sonarr — une seule règle (DECISIONS.md §48), lue par
 * l'ajout depuis la découverte et par les formulaires d'ajout de la gestion.
 *
 * Le profil réglé dans « Connexions » (`RADARR_QUALITY_PROFILE` / `SONARR_QUALITY_PROFILE`, un
 * identifiant), s'il existe encore chez le service ; sinon le premier de sa liste. Avant le
 * 05/10/2026, la découverte cherchait un profil dont le nom contenait « vf » et la gestion prenait
 * le premier : deux réponses pour la même question, et une règle qui ne valait que pour une
 * installation.
 */
export function defaultQualityProfile<P extends { id: number }>(service: "radarr" | "sonarr", profiles: readonly P[]): P | undefined {
  const wanted = Number(settingValue(service === "radarr" ? "RADARR_QUALITY_PROFILE" : "SONARR_QUALITY_PROFILE"));
  return (Number.isInteger(wanted) && wanted > 0 ? profiles.find((p) => p.id === wanted) : undefined) ?? profiles[0];
}
