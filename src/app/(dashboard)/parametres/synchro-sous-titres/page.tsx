"use client";

import { useT } from "@/components/TranslationProvider";
import { ConfigurationPage } from "@/components/settings/ConfigurationSection";
import { SubtitleSyncCard } from "@/components/settings/SubtitleSyncCard";
import { FeatureNeedsNotice } from "@/components/settings/FeatureNeeds";

/**
 * Fonctions intelligentes → Synchro des sous-titres (DECISIONS.md §141, §142) : mesurer, à la demande,
 * et recaler à l'affichage. La mesure est faite par le service des acteurs à l'écran : la page le dit
 * en tête, avec le lien vers ce qui manque, comme les cartes des autres fonctions.
 */
export default function SynchroSousTitresPage() {
  const t = useT();
  return (
    <ConfigurationPage title={t("subSync.nav")} subtitle={t("subSync.hint")}>
      <FeatureNeedsNotice needs={["xrayService", "xrayOn"]} />
      <SubtitleSyncCard />
    </ConfigurationPage>
  );
}
