"use client";

import { useT } from "@/components/TranslationProvider";
import { ConfigurationPage, ConfigurationSection } from "@/components/settings/ConfigurationSection";
import { CONFIG_LAYOUT } from "@/lib/settings/configLayout";

/**
 * Configuration → Connexions (DECISIONS.md §48, §81, §142) : l'adresse et la clé de chaque service —
 * le service des acteurs à l'écran compris, dont la fonction se règle dans Fonctions intelligentes —,
 * et ce que l'application elle-même publie (préchauffage des affiches, identité des notifications).
 * C'était « Réglages serveur », à `/parametres/connexions`, sous une page « Paramètres » qui
 * mêlait la langue et la couleur de l'administrateur aux clés de l'installation.
 */
export default function ConnexionsPage() {
  const t = useT();
  return (
    <ConfigurationPage title={t("nav.config.connections")} subtitle={t("config.connections.hint")}>
      <ConfigurationSection cards={CONFIG_LAYOUT.connections} showMissing />
    </ConfigurationPage>
  );
}
