"use client";

import { useT } from "@/components/TranslationProvider";
import { ConfigurationPage } from "@/components/settings/ConfigurationSection";
import { DialogueSearchCard } from "@/components/settings/DialogueSearchCard";

/** Configuration → Recherche de répliques (DECISIONS.md §88) : l'option, l'indexation, la nuit, l'index. */
export default function RepliquesPage() {
  const t = useT();
  return (
    <ConfigurationPage title={t("nav.config.dialogue")} subtitle={t("config.dialogue.hint")}>
      <DialogueSearchCard />
    </ConfigurationPage>
  );
}
