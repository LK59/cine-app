"use client";

import { useT } from "@/components/TranslationProvider";
import { ConfigurationPage, ConfigurationSection } from "@/components/settings/ConfigurationSection";
import { CONFIG_LAYOUT } from "@/lib/settings/configLayout";

/**
 * Fonctions intelligentes → Recadrage automatique (DECISIONS.md §142) : agrandir l'image au-dessus
 * des bandes noires, d'après les vignettes de Jellyfin (`/api/player/frame`). Le lecteur intégré
 * seulement — la carte le dit quand il est coupé.
 */
export default function RecadragePage() {
  const t = useT();
  return (
    <ConfigurationPage title={t("nav.config.autoFrame")} subtitle={t("config.autoFrame.hint")}>
      <ConfigurationSection cards={CONFIG_LAYOUT.autoFrame} />
    </ConfigurationPage>
  );
}
