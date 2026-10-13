"use client";

import { useCallback, useEffect, useState } from "react";
import useSWR from "swr";
import { RefreshCw } from "lucide-react";
import { fetcher } from "@/lib/swr";
import { Toggle } from "@/components/Toggle";
import { APP_BUILD, APP_VERSION, displayVersion } from "@/lib/appBuild";
import { useT } from "@/components/TranslationProvider";
import { hardRefreshApp } from "@/lib/pwaRefresh";
import { useToast } from "@/components/Toast";
import { apiAction } from "@/lib/apiAction";

/**
 * Les cartes de la Configuration qui ne sont pas des réglages du schéma (DECISIONS.md §81) :
 * la recherche de débogage (propre à ce navigateur), la version et la mise à jour de l'application,
 * et l'écran d'accueil proposé compte par compte. Elles vivaient dans l'ancienne page
 * « Paramètres », entre la langue, la couleur d'accent et les sessions — parties au Compte du
 * cinéma, ou supprimées pour l'accent.
 */

/** Une carte de Configuration : un titre, une phrase, puis son contenu. */
export function ConfigCardFrame({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="settings-card rounded-2xl border border-white/10 bg-white/[0.03] p-4 sm:p-5">
      <h3 className="text-base font-semibold text-white">{title}</h3>
      {hint && <p className="mt-0.5 text-sm text-muted">{hint}</p>}
      <div className="mt-4">{children}</div>
    </section>
  );
}

/** « Recherche de débogage » : dit dans la recherche pourquoi chaque résultat apparaît. Gardée par navigateur. */
export function SearchDebugCard() {
  const t = useT();
  const [searchDebug, setSearchDebug] = useState(false);

  // localStorage is unavailable during SSR — must be read post-mount. State starts at the
  // fixed `false`, matching SSR output, so this doesn't cause a hydration mismatch.
  useEffect(() => {
    try {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setSearchDebug(localStorage.getItem("cine:search-debug") === "1");
    } catch {
      /* stockage indisponible : la case reste éteinte */
    }
  }, []);

  const toggle = useCallback((enabled: boolean) => {
    setSearchDebug(enabled);
    try {
      localStorage.setItem("cine:search-debug", enabled ? "1" : "0");
    } catch {
      /* stockage indisponible : le réglage vaut pour cette page seulement */
    }
    window.dispatchEvent(new Event("search-debug-change"));
  }, []);

  return (
    <ConfigCardFrame title={t("settings.debug.title")} hint={t("settings.debug.subtitle")}>
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-sm font-medium text-white">{t("settings.debug.debugSearch")}</p>
          <p className="mt-1 text-xs leading-5 text-subtle">{t("settings.debug.debugSearchDesc")}</p>
        </div>
        <Toggle checked={searchDebug} onChange={toggle} ariaLabel={t("settings.debug.debugSearch")} />
      </div>
    </ConfigCardFrame>
  );
}

export function PwaUpdateCard() {
  const [refreshing, setRefreshing] = useState(false);
  const t = useT();

  const refresh = useCallback(async () => {
    if (refreshing) return;
    setRefreshing(true);
    await hardRefreshApp();
  }, [refreshing]);

  return (
    <ConfigCardFrame title={t('settings.app.title')}>
    <div className="flex items-center justify-between gap-4">
      <div>
        <p className="text-sm font-medium text-white">{t('settings.app.updateTitle')}</p>
        <p className="mt-0.5 text-xs text-subtle">{t('settings.app.updateDesc')}</p>
        {/* La version d'abord, façon iOS (« 8.1 »), le commit entre parenthèses : la première dit
            quelle livraison, le second quel code exact — deux builds d'une même version ne se
            distinguent que par lui. */}
        <p className="mt-1 text-[11px] text-subtle">
          {t('settings.app.version', { version: displayVersion(APP_VERSION) })} ({APP_BUILD})
        </p>
      </div>
      <button
        onClick={refresh}
        disabled={refreshing}
        className="btn btn-ghost shrink-0 rounded-full px-4 py-2"
      >
        <RefreshCw size={13} className={refreshing ? "animate-spin" : ""} />
        {refreshing ? t('settings.app.checking') : t('settings.app.updateButton')}
      </button>
    </div>
    </ConfigCardFrame>
  );
}

/**
 * L'écran d'accueil du cinéma, compte par compte (21/09/2026).
 *
 * Allumer, c'est le proposer au prochain lancement de l'application ; il s'éteint tout seul quand
 * la personne va jusqu'au bout — pas quand elle passe. « Proposer à tous » est le geste de mise en
 * ligne, une fois l'accueil validé sur son propre compte.
 */
export function OnboardingAdminSection() {
  const t = useT();
  const toast = useToast();
  const { data, mutate } = useSWR<{ accounts: { name: string; pending: boolean }[] }>("/api/admin/onboarding", fetcher);

  async function put(body: { user?: string; all?: boolean; pending: boolean }) {
    try {
      const next = (await apiAction("/api/admin/onboarding", { method: "PUT", body: JSON.stringify(body) })) as {
        accounts: { name: string; pending: boolean }[];
      };
      await mutate(next, { revalidate: false });
    } catch (error) {
      toast.error(error instanceof Error && error.message ? error.message : t("common.error"));
    }
  }

  return (
    <ConfigCardFrame title={t("settings.onboarding.title")} hint={t("settings.onboarding.hint")}>
      <div className="divide-y divide-white/5 overflow-hidden rounded-xl bg-white/4">
        {(data?.accounts ?? []).map((account) => (
          <div key={account.name} className="flex items-center justify-between gap-4 px-4 py-3">
            <span className="text-sm text-white">{account.name}</span>
            <Toggle
              checked={account.pending}
              onChange={(pending) => void put({ user: account.name, pending })}
              ariaLabel={`${t("settings.onboarding.pending")} — ${account.name}`}
            />
          </div>
        ))}
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        <button type="button" className="btn btn-ghost rounded-full" onClick={() => void put({ all: true, pending: true })}>
          {t("settings.onboarding.all")}
        </button>
        <button type="button" className="btn btn-ghost rounded-full" onClick={() => void put({ all: true, pending: false })}>
          {t("settings.onboarding.none")}
        </button>
      </div>
    </ConfigCardFrame>
  );
}
