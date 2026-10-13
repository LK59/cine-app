"use client";

import { useT } from "@/components/TranslationProvider";
import { ConfigurationPage, ConfigurationSection, type ConfigCard } from "@/components/settings/ConfigurationSection";

/**
 * Configuration → Lecture : le lecteur intégré, le repli vers le lecteur du serveur, le recadrage
 * automatique, le Chromecast. Tout se relit à chaque requête côté serveur (DECISIONS.md §48) ; un
 * onglet déjà ouvert l'apprend à son prochain chargement.
 */
const CARDS: readonly ConfigCard[] = [{ group: "playback" }];

export default function LecturePage() {
  const t = useT();
  return (
    <ConfigurationPage title={t("nav.config.playback")} subtitle={t("config.playback.hint")}>
      <ConfigurationSection cards={CARDS} />
    </ConfigurationPage>
  );
}
