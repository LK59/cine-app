"use client";

import { useT } from "@/components/TranslationProvider";
import { ConfigurationPage, ConfigurationSection } from "@/components/settings/ConfigurationSection";
import { XrayScanCard } from "@/components/settings/XrayScanCard";
import { XrayQualityCard } from "@/components/settings/XrayQualityCard";
import { CONFIG_LAYOUT } from "@/lib/settings/configLayout";

/**
 * Fonctions intelligentes → Acteurs à l'écran (DECISIONS.md §138, §142) : à qui la fonction est
 * ouverte (`XRAY_ENABLED`, sorti de Connexions le 10/11/2026 — Connexions garde l'adresse et la clé du
 * service), l'analyse de la bibliothèque en fond (planificateur), et la qualité des noms (10.30).
 * Les réglages propres à la fonction qui viendront (le retour au début d'une scène) se rangent ici,
 * entre l'interrupteur et l'analyse.
 */
export default function ActeursPage() {
  const t = useT();
  return (
    <ConfigurationPage title={t("xrayScan.nav")} subtitle={t("xrayScan.hint")}>
      <ConfigurationSection cards={CONFIG_LAYOUT.xray} />
      <XrayScanCard />
      <XrayQualityCard />
    </ConfigurationPage>
  );
}
