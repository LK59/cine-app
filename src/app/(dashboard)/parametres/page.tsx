"use client";

import { useT } from "@/components/TranslationProvider";
import { ConfigurationPage, ConfigurationSection, type ConfigCard } from "@/components/settings/ConfigurationSection";

/**
 * Configuration → Connexions (DECISIONS.md §48, §81) : l'adresse et la clé de chaque service, et
 * ce que l'application elle-même publie (préchauffage des affiches, identité des notifications).
 * C'était « Réglages serveur », à `/parametres/connexions`, sous une page « Paramètres » qui
 * mêlait la langue et la couleur de l'administrateur aux clés de l'installation.
 */
const CARDS: readonly ConfigCard[] = [
  { group: "jellyfin" },
  { group: "tmdb" },
  { group: "radarr" },
  { group: "sonarr" },
  { group: "jellyseerr" },
  { group: "qbittorrent" },
  { group: "bazarr" },
  { group: "jackett" },
  { group: "ratings" },
  { group: "app", keys: ["POSTER_PREWARM", "VAPID_SUBJECT"] },
];

export default function ConnexionsPage() {
  const t = useT();
  return (
    <ConfigurationPage title={t("nav.config.connections")} subtitle={t("config.connections.hint")}>
      <ConfigurationSection cards={CARDS} showMissing />
    </ConfigurationPage>
  );
}
