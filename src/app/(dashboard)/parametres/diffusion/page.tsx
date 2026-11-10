"use client";

import { useT } from "@/components/TranslationProvider";
import { ConfigurationPage, ConfigurationSection } from "@/components/settings/ConfigurationSection";
import { CONFIG_LAYOUT } from "@/lib/settings/configLayout";

/**
 * Configuration → Diffusion et hors-ligne (DECISIONS.md §64, §142) : le Chromecast, puis les
 * téléchargements gardés sur l'appareil. Sortis de « Lecture » le 10/11/2026, qui ne garde que le
 * lecteur. Tout se relit à chaque requête côté serveur (§48).
 */
export default function DiffusionPage() {
  const t = useT();
  return (
    <ConfigurationPage title={t("nav.config.diffusion")} subtitle={t("config.diffusion.hint")}>
      <ConfigurationSection cards={CONFIG_LAYOUT.diffusion} />
    </ConfigurationPage>
  );
}
