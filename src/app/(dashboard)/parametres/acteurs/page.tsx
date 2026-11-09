"use client";

import { useT } from "@/components/TranslationProvider";
import { ConfigurationPage } from "@/components/settings/ConfigurationSection";
import { XrayScanCard } from "@/components/settings/XrayScanCard";
import { XrayQualityCard } from "@/components/settings/XrayQualityCard";

/** Configuration → Acteurs à l'écran (DECISIONS.md §138, planificateur) : l'analyse de la bibliothèque en fond, et la qualité des noms (10.30). */
export default function ActeursPage() {
  const t = useT();
  return (
    <ConfigurationPage title={t("xrayScan.nav")} subtitle={t("xrayScan.hint")}>
      <XrayScanCard />
      <XrayQualityCard />
    </ConfigurationPage>
  );
}
