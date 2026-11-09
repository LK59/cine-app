"use client";

import { useT } from "@/components/TranslationProvider";
import { ConfigurationPage } from "@/components/settings/ConfigurationSection";
import { XrayScanCard } from "@/components/settings/XrayScanCard";

/** Configuration → Acteurs à l'écran (DECISIONS.md §138, planificateur) : l'analyse de la bibliothèque en fond. */
export default function ActeursPage() {
  const t = useT();
  return (
    <ConfigurationPage title={t("xrayScan.nav")} subtitle={t("xrayScan.hint")}>
      <XrayScanCard />
    </ConfigurationPage>
  );
}
