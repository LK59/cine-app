"use client";

import { useT } from "@/components/TranslationProvider";
import { ConfigurationPage, ConfigurationSection, type ConfigCard } from "@/components/settings/ConfigurationSection";

/** Configuration → Sous-titres générés (DECISIONS.md §69) : fournisseur, clé, budget, tâches. */
const CARDS: readonly ConfigCard[] = [{ group: "subtitles" }];

export default function SousTitresPage() {
  const t = useT();
  return (
    <ConfigurationPage title={t("nav.config.subtitles")} subtitle={t("config.subtitles.hint")}>
      <ConfigurationSection cards={CARDS} />
    </ConfigurationPage>
  );
}
