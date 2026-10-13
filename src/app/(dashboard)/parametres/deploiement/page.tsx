"use client";

import { useMemo } from "react";
import useSWR from "swr";
import { fetcher } from "@/lib/swr";
import { useT } from "@/components/TranslationProvider";
import { ConfigurationPage } from "@/components/settings/ConfigurationSection";
import { DeploymentGuide } from "@/components/settings/SettingsGroupCard";
import type { SettingView } from "@/lib/settings/schema";

/**
 * Configuration → Déploiement, en dernier : ce qui ne se règle pas d'ici parce qu'il faut toucher au
 * `docker-compose.yml` ou au `.env` — un dossier à monter (chemins des médias pour le stockage et
 * les statistiques), le fuseau, le relais de confiance, le cookie sécurisé — avec la ligne à copier.
 * Depuis le 13/10/2026, elle dit aussi si le relais de confiance et le cookie sécurisé sont posés :
 * lus dans l'environnement du conteneur (les mêmes réglages que `/api/settings`, réservé à
 * l'administrateur), sans quoi rien ne permettait de vérifier qu'une ligne ajoutée avait pris.
 */
export default function DeploiementPage() {
  const t = useT();
  const { data } = useSWR<{ settings: SettingView[] }>("/api/settings", fetcher);
  const views = useMemo(() => (data ? new Map(data.settings.map((v) => [v.key, v])) : undefined), [data]);
  return (
    <ConfigurationPage title={t("nav.config.deployment")} subtitle={t("config.deployment.hint")}>
      <DeploymentGuide views={views} />
    </ConfigurationPage>
  );
}
