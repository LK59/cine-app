"use client";

import { useT } from "@/components/TranslationProvider";
import { ConfigurationPage } from "@/components/settings/ConfigurationSection";
import { DeploymentGuide } from "@/components/settings/SettingsGroupCard";

/**
 * Configuration → Déploiement, en dernier : ce qui ne se règle pas d'ici parce qu'il faut toucher au
 * `docker-compose.yml` ou au `.env` — un dossier à monter (chemins des médias pour le stockage et
 * les statistiques), le fuseau, le relais de confiance, le cookie sécurisé — avec la ligne à copier.
 */
export default function DeploiementPage() {
  const t = useT();
  return (
    <ConfigurationPage title={t("nav.config.deployment")} subtitle={t("config.deployment.hint")}>
      <DeploymentGuide />
    </ConfigurationPage>
  );
}
