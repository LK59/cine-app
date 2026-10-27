"use client";

import { useT } from "@/components/TranslationProvider";
import { ConfigurationPage } from "@/components/settings/ConfigurationSection";
import { AdminPasswordCard } from "@/components/settings/AdminPasswordCard";
import { PwaUpdateCard, SearchDebugCard } from "@/components/settings/AdminTools";
import { StreamDeckCard } from "@/components/settings/StreamDeckCard";

/** Configuration → Administration : le mot de passe du compte local, la recherche de débogage, la version, les jetons du Stream Deck. */
export default function AdministrationPage() {
  const t = useT();
  return (
    <ConfigurationPage title={t("nav.config.admin")} subtitle={t("config.admin.hint")}>
      <AdminPasswordCard />
      <SearchDebugCard />
      <PwaUpdateCard />
      <StreamDeckCard />
    </ConfigurationPage>
  );
}
