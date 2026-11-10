"use client";

import { useT } from "@/components/TranslationProvider";
import { ConfigurationPage, ConfigurationSection } from "@/components/settings/ConfigurationSection";
import { CONFIG_LAYOUT } from "@/lib/settings/configLayout";

/**
 * Fonctions intelligentes → Intelligence artificielle (DECISIONS.md §69, §140, §142) : le fournisseur
 * commun — fournisseur, clé, modèle, plafond mensuel, prix —, puis chaque fonction qui s'en sert, avec
 * son public, ce dont elle a besoin et son état. C'était la page « Sous-titres générés »
 * (`/parametres/sous-titres`, qui redirige ici) : les clés `SUBTITLE_GEN_*` gardent ce nom.
 */
export default function IntelligenceArtificiellePage() {
  const t = useT();
  return (
    <ConfigurationPage title={t("nav.config.ai")} subtitle={t("config.ai.hint")}>
      <ConfigurationSection cards={CONFIG_LAYOUT.aiProvider} />
      <div>
        <h2 className="text-base font-semibold text-white">{t("config.ai.featuresTitle")}</h2>
        <p className="mt-0.5 text-sm text-muted">{t("config.ai.featuresIntro")}</p>
      </div>
      <ConfigurationSection cards={CONFIG_LAYOUT.aiFeatures} />
    </ConfigurationPage>
  );
}
