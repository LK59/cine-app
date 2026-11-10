"use client";

import { useT } from "@/components/TranslationProvider";
import { ConfigurationPage, ConfigurationSection } from "@/components/settings/ConfigurationSection";
import { CONFIG_LAYOUT } from "@/lib/settings/configLayout";

/**
 * Configuration → Livres (DECISIONS.md §127, §142) : l'option, les demandes, Google Books. Coupée
 * par défaut ; les deux dernières cartes disent qu'elles ne font rien sans elle.
 */
export default function LivresPage() {
  const t = useT();
  return (
    <ConfigurationPage title={t("nav.config.books")} subtitle={t("config.books.hint")}>
      <ConfigurationSection cards={CONFIG_LAYOUT.books} />
    </ConfigurationPage>
  );
}
