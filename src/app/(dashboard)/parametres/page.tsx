"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Bell, CircleCheckBig, Globe, Loader2, LogOut, Palette, RefreshCw, History, Settings, Shield, Smartphone } from "lucide-react";
import useSWR from "swr";
import { fetcher } from "@/lib/swr";
import { PageHeader } from "@/components/PageHeader";
import { Toggle } from "@/components/Toggle";
import { useTheme } from "@/components/ThemeProvider";
import { ACCENT_PRESETS } from "@/lib/theme";
import { useRole } from "@/lib/useRole";
import { useT, useLocale } from "@/components/TranslationProvider";
import { LOCALES, LOCALE_LABELS, type Locale } from "@/lib/i18n";
import { hardRefreshApp } from "@/lib/pwaRefresh";
import { useToast } from "@/components/Toast";
import { apiAction } from "@/lib/apiAction";
import { usePlayerServerFallback } from "@/lib/usePlayerEnabled";

export default function ParametresPage() {
  const { accent, setAccent } = useTheme();
  const { role } = useRole();
  const t = useT();

  const [searchDebug, setSearchDebug] = useState(false);

  // localStorage is unavailable during SSR — must be read post-mount. State starts at the
  // fixed `false`, matching SSR output, so this doesn't cause a hydration mismatch.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSearchDebug(localStorage.getItem("cine:search-debug") === "1");
  }, []);

  const toggleSearchDebug = useCallback((enabled: boolean) => {
    setSearchDebug(enabled);
    localStorage.setItem("cine:search-debug", enabled ? "1" : "0");
    window.dispatchEvent(new Event("search-debug-change"));
  }, []);

  return (
    <div>
      <PageHeader
        title={t('settings.pageTitle')}
        subtitle={t('settings.subtitle')}
      />

      <div className="space-y-8">

        {/* ── Langue ── */}
        <LanguageSection />

        {/* ── Apparence ── */}
        <section>
          <div className="mb-4 flex items-center gap-3">
            <div className="text-slate-500">
              <Palette size={18} />
            </div>
            <div>
              <h2 className="text-base font-semibold text-white">{t('settings.appearance.title')}</h2>
              <p className="text-xs text-slate-500">{t('settings.appearance.subtitle')}</p>
            </div>
          </div>

          <div>
            {/* Accent color picker */}
            <div className="card p-5">
              <p className="mb-4 text-sm font-medium text-white">{t('settings.appearance.accentColor')}</p>
              <div className="flex flex-wrap gap-3">
                {ACCENT_PRESETS.map((preset) => {
                  const active = accent === preset.key;
                  return (
                    <button
                      key={preset.key}
                      onClick={() => setAccent(preset.key)}
                      title={preset.label}
                      className="group flex flex-col items-center gap-2"
                    >
                      <span
                        className={[
                          "flex h-10 w-10 items-center justify-center rounded-full transition duration-200",
                          active ? "scale-110 ring-2 ring-white/60 ring-offset-2 ring-offset-ink" : "hover:scale-105 ring-2 ring-white/10",
                        ].join(" ")}
                        style={{ backgroundColor: preset.hex }}
                      >
                        {active && (
                          <svg viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4">
                            <polyline points="20 6 9 17 4 12" />
                          </svg>
                        )}
                      </span>
                      <span className={["text-[11px] font-medium transition-colors", active ? "text-white" : "text-slate-500 group-hover:text-slate-300"].join(" ")}>
                        {preset.label}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>

          </div>
        </section>

        {/* ── Notifications ──
            Elles se réglaient ici *et* dans le panneau Compte du cinéma, avec des libellés
            différents pour les mêmes choix. Il n'en reste qu'un endroit depuis le 23/09/2026 :
            le panneau Compte, où l'administrateur voit aussi les annonces de téléchargement. */}
        <section>
          <div className="mb-4 flex items-center gap-3">
            <div className="text-slate-500">
              <Bell size={18} />
            </div>
            <div>
              <h2 className="text-base font-semibold text-white">{t('notifications.pageTitle')}</h2>
            </div>
          </div>
          <div className="card flex flex-col gap-3 p-5 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
            <p className="text-sm text-slate-300">{t('settings.notifications.moved')}</p>
            <Link href="/#compte=1" className="btn btn-ghost btn-sm shrink-0">{t('settings.notifications.open')}</Link>
          </div>
        </section>

        {/* ── Sécurité ── */}
        <section>
          <div className="mb-4 flex items-center gap-3">
            <div className="text-slate-500">
              <Shield size={18} />
            </div>
            <div>
              <h2 className="text-base font-semibold text-white">{t('settings.security.title')}</h2>
              <p className="text-xs text-slate-500">{t('settings.security.subtitle')}</p>
            </div>
          </div>
          <SessionsCard />
        </section>

        {/* ── Application ── */}
        <section>
          <div className="mb-4 flex items-center gap-3">
            <div className="text-slate-500">
              <Smartphone size={18} />
            </div>
            <div>
              <h2 className="text-base font-semibold text-white">{t('settings.app.title')}</h2>
              <p className="text-xs text-slate-500">{t('settings.app.subtitle')}</p>
            </div>
          </div>
          <PwaUpdateCard />
        </section>

        {/* Open to everyone: the remux path is the ordinary way this player reads a file now,
            not an experiment to keep behind the admin account. Still off until each person
            turns it on, and still refused server-side for anyone who hasn't. */}
        <LegacyPlayerSection />

        {role === "admin" && (
          <section>
            <div className="mb-4 flex items-center gap-3">
              <div className="text-amber-400/80">
                <Settings size={18} />
              </div>
              <div>
                <h2 className="text-base font-semibold text-white">{t('settings.debug.title')}</h2>
                <p className="text-xs text-slate-500">{t('settings.debug.subtitle')}</p>
              </div>
            </div>

            <div className="card p-5">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <p className="text-sm font-medium text-white">{t('settings.debug.debugSearch')}</p>
                  <p className="mt-1 text-xs leading-5 text-slate-500">
                    {t('settings.debug.debugSearchDesc')}
                  </p>
                </div>
                <Toggle checked={searchDebug} onChange={toggleSearchDebug} />
              </div>
            </div>
          </section>
        )}

        {role === "admin" && <OnboardingAdminSection />}


      </div>
    </div>
  );
}

function LanguageSection() {
  const { locale, setLocale } = useLocale();
  const t = useT();
  const [pending, setPending] = useState<Locale | null>(null);
  const [saving, setSavingLang] = useState(false);

  function select(l: Locale) {
    if (l === locale) return;
    setPending(l);
  }

  async function apply() {
    if (!pending) return;
    setSavingLang(true);
    await setLocale(pending);
    setTimeout(() => window.location.reload(), 80);
  }

  const active = pending ?? locale;

  return (
    <section>
      <div className="mb-4 flex items-center gap-3">
        <div className="text-slate-500">
          <Globe size={18} />
        </div>
        <div>
          <h2 className="text-base font-semibold text-white">{t('settings.language.title')}</h2>
          <p className="text-xs text-slate-500">{t('settings.language.subtitle')}</p>
        </div>
      </div>

      <div className="card p-5">
        <div className="flex flex-wrap gap-3">
          {LOCALES.map((l) => (
            <button
              key={l}
              onClick={() => select(l)}
              /* Le même geste que les filtres de Découverte, donc la même forme : plein quand
                 c'est le choix retenu, presque rien sinon. Une bordure *et* un fond *et* un
                 rayon sur chaque option, c'est quatre boîtes qui se disputent une décision. */
              className={`chip px-5 py-2 ${active === l ? "chip-on" : ""}`}
            >
              {LOCALE_LABELS[l]}
            </button>
          ))}
        </div>

        {pending && pending !== locale && (
          <div className="mt-4 flex items-center justify-between gap-4 rounded-lg border border-amber-500/20 bg-amber-500/10 px-4 py-3">
            <p className="text-xs text-amber-300">
              {t('settings.language.reloadNotice', { lang: LOCALE_LABELS[pending] })}
            </p>
            <button
              onClick={apply}
              className="btn btn-sm shrink-0 bg-amber-500 text-black hover:bg-amber-400"
            >
              {t('settings.language.apply')}
            </button>
          </div>
        )}
      </div>
    </section>
  );
}

function SessionsCard() {
  const [count, setCount] = useState<number | null>(null);
  const [revoking, setRevoking] = useState(false);
  const [revoked, setRevoked] = useState(false);
  const t = useT();
  const toast = useToast();

  useEffect(() => {
    fetch("/api/auth/sessions")
      .then((r) => r.ok ? r.json() : null)
      .then((j) => { if (j != null) setCount(j.count); });
  }, []);

  async function revokeOthers() {
    setRevoking(true);
    try {
      // Une révocation refusée ne disait rien du tout : le bouton revenait à son état de repos
      // comme si l'utilisateur n'avait jamais cliqué, et les autres sessions restaient ouvertes.
      await apiAction("/api/auth/sessions", { method: "DELETE" });
      setCount(0);
      setRevoked(true);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('common.error'));
    } finally {
      setRevoking(false);
    }
  }

  return (
    <div className="card p-5">
      <div className="flex items-center justify-between gap-4">
        <div>
          <p className="text-sm font-medium text-white">{t('settings.security.sessionsTitle')}</p>
          <p className="mt-0.5 text-xs text-slate-500">
            {count === null
              ? t('settings.security.loading')
              : count === 0
              ? t('settings.security.noOtherSessions')
              : t('settings.security.otherSessions', { n: count })}
          </p>
        </div>
        <button
          onClick={revokeOthers}
          disabled={revoking || count === 0 || revoked}
          className="btn btn-ghost btn-sm shrink-0 text-red-400"
        >
          {revoking ? <Loader2 size={13} className="animate-spin" /> : <LogOut size={13} />}
          {revoked ? t('settings.security.revoked') : t('settings.security.revokeAll')}
        </button>
      </div>
      {revoked && (
        <p className="mt-3 flex items-center gap-1.5 text-xs text-emerald-400">
          <CircleCheckBig size={13} /> {t('settings.security.revokeSuccess')}
        </p>
      )}
    </div>
  );
}

function PwaUpdateCard() {
  const [refreshing, setRefreshing] = useState(false);
  const t = useT();

  const refresh = useCallback(async () => {
    if (refreshing) return;
    setRefreshing(true);
    await hardRefreshApp();
  }, [refreshing]);

  return (
    <div className="card p-5 flex items-center justify-between gap-4">
      <div>
        <p className="text-sm font-medium text-white">{t('settings.app.updateTitle')}</p>
        <p className="text-xs text-slate-500 mt-0.5">{t('settings.app.updateDesc')}</p>
        {process.env.NEXT_PUBLIC_APP_VERSION && (
          <p className="text-[11px] text-slate-600 mt-1">
            v{process.env.NEXT_PUBLIC_APP_VERSION}
            {process.env.NEXT_PUBLIC_APP_BUILD ? ` · ${process.env.NEXT_PUBLIC_APP_BUILD}` : ""}
          </p>
        )}
      </div>
      <button
        onClick={refresh}
        disabled={refreshing}
        className="btn btn-ghost px-4 py-2"
      >
        <RefreshCw size={13} className={refreshing ? "animate-spin" : ""} />
        {refreshing ? t('settings.app.checking') : t('settings.app.updateButton')}
      </button>
    </div>
  );
}

// The opt-out, back to playback through the server. Off by default, and the server enforces
// that independently of this UI — the route that serves a file to the native player refuses an
// account that has asked to be sent back.
//
// Renders nothing where that player does not exist (PLAYER_SERVER_FALLBACK off): a switch whose
// two positions do the same thing is worse than no switch. The route applies the same rule, so
// hiding it here is presentation, not enforcement.
function LegacyPlayerSection() {
  const t = useT();
  const toast = useToast();
  const serverFallback = usePlayerServerFallback();
  const { data, mutate } = useSWR<{ legacyPlayer?: { enabled: boolean } }>("/api/user/preferences", fetcher);
  const enabled = data?.legacyPlayer?.enabled ?? false;

  async function update(next: boolean) {
    // Optimistic, then reconciled with what the server actually stored.
    await mutate(
      async () => {
        const res = await fetch("/api/user/preferences", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ legacyPlayer: next }),
        });
        if (res.ok) return { legacyPlayer: (await res.json()).legacyPlayer };
        // Revenir en arrière, et le dire : l'interrupteur retombait sans un mot.
        toast.error(t("common.error"));
        return { legacyPlayer: { enabled } };
      },
      { optimisticData: { legacyPlayer: { enabled: next } }, revalidate: false }
    );
  }

  if (serverFallback === false) return null;

  return (
    <section>
      <div className="mb-4 flex items-center gap-3">
        <div className="text-slate-500">
          <History size={18} />
        </div>
        <div>
          <h2 className="text-base font-semibold text-white">{t("settings.legacyPlayer.title")}</h2>
          <p className="text-xs text-slate-500">{t("settings.legacyPlayer.subtitle")}</p>
        </div>
      </div>

      <div className="card space-y-5 p-5">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-sm font-medium text-white">{t("settings.legacyPlayer.enable")}</p>
            <p className="mt-1 text-xs leading-5 text-slate-500">{t("settings.legacyPlayer.enableDesc")}</p>
          </div>
          <Toggle checked={enabled} onChange={update} />
        </div>
      </div>
    </section>
  );
}

/**
 * L'écran d'accueil du cinéma, compte par compte (21/09/2026).
 *
 * Allumer, c'est le proposer au prochain lancement de l'application ; il s'éteint tout seul quand
 * la personne va jusqu'au bout — pas quand elle passe. « Proposer à tous » est le geste de mise en
 * ligne, une fois l'accueil validé sur son propre compte.
 */
function OnboardingAdminSection() {
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
    <section className="space-y-3">
      <div>
        <h2 className="text-base font-semibold text-white">{t("settings.onboarding.title")}</h2>
        <p className="text-xs text-slate-500">{t("settings.onboarding.hint")}</p>
      </div>
      <div className="card divide-y divide-white/5">
        {(data?.accounts ?? []).map((account) => (
          <div key={account.name} className="flex items-center justify-between gap-4 px-5 py-3">
            <span className="text-sm text-white">{account.name}</span>
            <Toggle
              checked={account.pending}
              onChange={(pending) => void put({ user: account.name, pending })}
              ariaLabel={`${t("settings.onboarding.pending")} — ${account.name}`}
            />
          </div>
        ))}
      </div>
      <div className="flex flex-wrap gap-2">
        <button type="button" className="btn btn-ghost" onClick={() => void put({ all: true, pending: true })}>
          {t("settings.onboarding.all")}
        </button>
        <button type="button" className="btn btn-ghost" onClick={() => void put({ all: true, pending: false })}>
          {t("settings.onboarding.none")}
        </button>
      </div>
    </section>
  );
}
