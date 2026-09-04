"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Bell, CircleCheckBig, Globe, Loader2, LogOut, Moon, Palette, RefreshCw, History, Send, Settings, Shield, Smartphone, CircleX } from "lucide-react";
import useSWR from "swr";
import { fetcher } from "@/lib/swr";
import { PageHeader } from "@/components/PageHeader";
import { PushToggle } from "@/components/PushToggle";
import { Toggle } from "@/components/Toggle";
import { NOTIFICATION_CATEGORIES, getDefaultNotificationPreferences, type NotificationCategory } from "@/lib/notifications";
import { useTheme } from "@/components/ThemeProvider";
import { ACCENT_PRESETS } from "@/lib/theme";
import { useRole } from "@/lib/useRole";
import { useT, useLocale } from "@/components/TranslationProvider";
import { LOCALES, LOCALE_LABELS, type Locale } from "@/lib/i18n";
import { hardRefreshApp } from "@/lib/pwaRefresh";

type TestState = "idle" | "sending" | "sent" | "error";

export default function ParametresPage() {
  const { accent, amoled, setAccent, setAmoled } = useTheme();
  const { role } = useRole();
  const t = useT();

  // Notification state
  const [preferences, setPreferences] = useState<Record<NotificationCategory, boolean>>(getDefaultNotificationPreferences);
  const [loadingPrefs, setLoadingPrefs] = useState(true);
  const [saving, setSaving] = useState<NotificationCategory | null>(null);
  const [testState, setTestState] = useState<TestState>("idle");
  const [countdown, setCountdown] = useState<number | null>(null);
  const [searchDebug, setSearchDebug] = useState(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    fetch("/api/notifications/settings")
      .then((res) => (res.ok ? res.json() : null))
      .then((json) => { if (json?.preferences) setPreferences(json.preferences); })
      .finally(() => setLoadingPrefs(false));
  }, []);

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

  useEffect(() => () => { if (timerRef.current) clearInterval(timerRef.current); }, []);

  const savePreference = useCallback(async (category: NotificationCategory, enabled: boolean) => {
    setPreferences((prev) => ({ ...prev, [category]: enabled }));
    setSaving(category);
    try {
      const res = await fetch("/api/notifications/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ preferences: { [category]: enabled } }),
      });
      const json = await res.json().catch(() => null);
      if (res.ok && json?.preferences) setPreferences(json.preferences);
    } finally {
      setSaving(null);
    }
  }, []);

  const startTest = useCallback(() => {
    if (countdown !== null) return;
    setTestState("idle");
    setCountdown(5);
    let remaining = 5;
    timerRef.current = setInterval(() => {
      remaining -= 1;
      if (remaining <= 0) {
        clearInterval(timerRef.current!);
        timerRef.current = null;
        setCountdown(null);
        setTestState("sending");
        fetch("/api/push/test", { method: "POST" })
          .then(async (res) => {
            const json = await res.json().catch(() => ({}));
            setTestState(res.ok && json.ok ? "sent" : "error");
          })
          .catch(() => setTestState("error"));
      } else {
        setCountdown(remaining);
      }
    }, 1000);
  }, [countdown]);

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

          <div className="grid gap-4 lg:grid-cols-2">
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

            {/* AMOLED toggle */}
            <div className="card p-5">
              <div className="flex items-start justify-between gap-4">
                <div className="flex items-start gap-3">
                  <div className="mt-0.5 text-slate-500">
                    <Moon size={16} />
                  </div>
                  <div>
                    <p className="text-sm font-medium text-white">{t('settings.appearance.ultraDark')}</p>
                    <p className="mt-1 text-xs leading-5 text-slate-500">
                      {t('settings.appearance.ultraDarkDesc')}
                    </p>
                  </div>
                </div>
                <Toggle checked={amoled} onChange={setAmoled} />
              </div>
            </div>
          </div>
        </section>

        {/* ── Notifications ── */}
        <section>
          <div className="mb-4 flex items-center gap-3">
            <div className="text-slate-500">
              <Bell size={18} />
            </div>
            <div>
              <h2 className="text-base font-semibold text-white">{t('notifications.pageTitle')}</h2>
              <p className="text-xs text-slate-500">{t('settings.notifications.subtitle')}</p>
            </div>
          </div>

          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
            <div className="space-y-4">
              <div className="card p-5">
                <div className="mb-5 flex items-start gap-3">
                  <div className="text-slate-500">
                    <Settings size={16} />
                  </div>
                  <div>
                    <p className="text-sm font-semibold text-white">{t('notifications.thisDevice')}</p>
                    <p className="mt-0.5 text-xs text-slate-500">{t('notifications.deviceNotice')}</p>
                  </div>
                </div>
                <div className="flex items-center justify-between gap-4">
                  <div>
                    <p className="text-sm font-medium text-white">{t('notifications.pushNotifications')}</p>
                    <p className="mt-0.5 text-xs text-slate-500">{t('notifications.pushDescription')}</p>
                  </div>
                  <PushToggle />
                </div>
              </div>

              <div className="card p-5">
                <div className="mb-5">
                  <p className="text-sm font-semibold text-white">{t('notifications.categories')}</p>
                  <p className="mt-0.5 text-xs text-slate-500">{t('notifications.categoriesDescription')}</p>
                </div>
                <div className="divide-y divide-white/5">
                  {NOTIFICATION_CATEGORIES.map((category) => (
                    <div key={category.id} className="flex items-center justify-between gap-4 py-3 first:pt-0 last:pb-0">
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-white">{t(category.labelKey)}</p>
                        <p className="mt-0.5 text-xs text-slate-500">{t(category.descKey)}</p>
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        {saving === category.id && <Loader2 size={13} className="animate-spin text-slate-500" />}
                        <Toggle
                          checked={loadingPrefs ? category.enabledByDefault : preferences[category.id]}
                          onChange={(enabled) => savePreference(category.id, enabled)}
                        />
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            <div className="card h-fit p-5">
              <div className="mb-5">
                <p className="text-sm font-semibold text-white">{t('notifications.test')}</p>
                <p className="mt-0.5 text-xs text-slate-500">{t('notifications.testDescription')}</p>
              </div>
              <button
                onClick={startTest}
                disabled={countdown !== null || testState === "sending"}
                className="btn btn-ghost btn-lg w-full"
              >
                {countdown !== null || testState === "sending" ? (
                  <><Loader2 size={15} className="animate-spin" />{countdown !== null ? t('notifications.sendingIn', { n: countdown }) : t('notifications.sending')}</>
                ) : (
                  <><Send size={15} />{t('notifications.testButton')}</>
                )}
              </button>
              {testState === "sent" && (
                <p className="mt-3 flex items-center gap-1.5 text-xs text-emerald-400"><CircleCheckBig size={13} /> {t('notifications.sent')}</p>
              )}
              {testState === "error" && (
                <p className="mt-3 flex items-center gap-1.5 text-xs text-red-400"><CircleX size={13} /> {t('notifications.sendError')}</p>
              )}
            </div>
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

        {/* Open to everyone: the remux path is the ordinary way this player reads a file now,
            not an experiment to keep behind the admin account. Still off until each person
            turns it on, and still refused server-side for anyone who hasn't. */}
        <LegacyPlayerSection />

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
              className="shrink-0 rounded-lg bg-amber-500 px-4 py-1.5 text-xs font-semibold text-black transition-opacity hover:opacity-90"
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

  useEffect(() => {
    fetch("/api/auth/sessions")
      .then((r) => r.ok ? r.json() : null)
      .then((j) => { if (j != null) setCount(j.count); });
  }, []);

  async function revokeOthers() {
    setRevoking(true);
    try {
      const res = await fetch("/api/auth/sessions", { method: "DELETE" });
      if (res.ok) { setCount(0); setRevoked(true); }
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
          className="flex shrink-0 items-center gap-1.5 rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-1.5 text-xs font-medium text-red-400 transition-colors hover:bg-red-500/20 disabled:cursor-not-allowed disabled:opacity-40"
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
          <p className="text-[11px] text-slate-600 mt-1">v{process.env.NEXT_PUBLIC_APP_VERSION}</p>
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
function LegacyPlayerSection() {
  const t = useT();
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
        return res.ok ? { legacyPlayer: (await res.json()).legacyPlayer } : { legacyPlayer: { enabled } };
      },
      { optimisticData: { legacyPlayer: { enabled: next } }, revalidate: false }
    );
  }

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
