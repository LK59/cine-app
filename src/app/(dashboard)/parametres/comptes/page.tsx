"use client";

import { useT } from "@/components/TranslationProvider";
import { ConfigurationPage, ConfigurationSection, type ConfigCard } from "@/components/settings/ConfigurationSection";
import { OnboardingAdminSection } from "@/components/settings/AdminTools";

/**
 * Configuration → Comptes : ce que reçoit un compte qui n'a rien choisi — sa langue, la disposition
 * de son accueil (§52), les tags masqués posés à sa découverte (§56) — et l'écran d'accueil à
 * proposer compte par compte. Ce que chacun règle pour lui-même reste dans son Compte, au cinéma.
 */
const CARDS: readonly ConfigCard[] = [{ group: "app", keys: ["APP_LANGUAGE"] }, { group: "defaults" }];

export default function ComptesPage() {
  const t = useT();
  return (
    <ConfigurationPage title={t("nav.config.accounts")} subtitle={t("config.accounts.hint")}>
      <ConfigurationSection cards={CARDS} />
      <OnboardingAdminSection />
    </ConfigurationPage>
  );
}
