"use client";

import { useT } from "@/components/TranslationProvider";
import { ConfigurationPage, ConfigurationSection } from "@/components/settings/ConfigurationSection";
import { CONFIG_LAYOUT } from "@/lib/settings/configLayout";

/**
 * Configuration → Lecture : le lecteur intégré et son repli vers le lecteur du serveur, rien
 * d'autre depuis le 10/11/2026 (DECISIONS.md §142) — le Chromecast et le hors-ligne sont dans
 * « Diffusion et hors-ligne », les livres dans « Livres », le recadrage dans les Fonctions
 * intelligentes. Tout se relit à chaque requête côté serveur (§48) ; un onglet déjà ouvert
 * l'apprend à son prochain chargement.
 */
export default function LecturePage() {
  const t = useT();
  return (
    <ConfigurationPage title={t("nav.config.playback")} subtitle={t("config.playback.hint")}>
      <ConfigurationSection cards={CONFIG_LAYOUT.playback} />
    </ConfigurationPage>
  );
}
