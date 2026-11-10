"use client";

import { useT } from "@/components/TranslationProvider";
import { ConfigurationPage } from "@/components/settings/ConfigurationSection";
import { SubtitleSyncCard } from "@/components/settings/SubtitleSyncCard";

/** Configuration → Synchro des sous-titres (DECISIONS.md §141) : mesurer, à la demande, et recaler à l'affichage. */
export default function SynchroSousTitresPage() {
  const t = useT();
  return (
    <ConfigurationPage title={t("subSync.nav")} subtitle={t("subSync.hint")}>
      <SubtitleSyncCard />
    </ConfigurationPage>
  );
}
