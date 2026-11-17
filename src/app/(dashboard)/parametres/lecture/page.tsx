"use client";

import { useT } from "@/components/TranslationProvider";
import { ConfigurationPage, ConfigurationSection } from "@/components/settings/ConfigurationSection";
import { PlayerRanges } from "@/components/settings/PlayerRanges";
import { CONFIG_LAYOUT } from "@/lib/settings/configLayout";

/**
 * Configuration → Lecture : les lecteurs de Laterna (qui est qui, ce que chacun demande au serveur), le lecteur
 * intégré et son repli, puis Lumen serveur et ses options déployables à part (DECISIONS.md §142, §194) — le
 * Chromecast et le hors-ligne sont dans « Diffusion et hors-ligne », les livres dans « Livres », le recadrage dans
 * les Fonctions intelligentes. Tout se relit à chaque requête côté serveur (§48) ; un onglet déjà ouvert
 * l'apprend à son prochain chargement.
 */
export default function LecturePage() {
  const t = useT();
  return (
    <ConfigurationPage title={t("nav.config.playback")} subtitle={t("config.playback.hint")}>
      <PlayerRanges />
      <ConfigurationSection cards={CONFIG_LAYOUT.playback} />
      {/* Lumen serveur et ses options, chacune avec ses prérequis (§194) : l'installation, le son, la version allégée. */}
      <h2 className="pt-2 text-lg font-semibold text-white">{t("config.lumenSection")}</h2>
      <ConfigurationSection cards={CONFIG_LAYOUT.lumenServer} />
    </ConfigurationPage>
  );
}
