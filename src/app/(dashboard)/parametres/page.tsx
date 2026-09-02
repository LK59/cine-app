"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Bell, CircleCheckBig, Film, Globe, Loader2, LogOut, Moon, Palette, RefreshCw, Send, Settings, Shield, Smartphone, CircleX } from "lucide-react";
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
            <div className="rounded-lg bg-accent-500/10 p-2 text-accent-400 ring-1 ring-inset ring-accent-500/20">
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
                          active ? "scale-110 ring-2 ring-white/60 ring-offset-2 ring-offset-slate-950" : "hover:scale-105 ring-2 ring-white/10",
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
                  <div className="mt-0.5 rounded-lg bg-slate-800 p-2 text-slate-300 ring-1 ring-inset ring-white/10">
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
            <div className="rounded-lg bg-accent-500/10 p-2 text-accent-400 ring-1 ring-inset ring-accent-500/20">
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
                  <div className="rounded-lg bg-accent-500/10 p-2 text-accent-400 ring-1 ring-inset ring-accent-500/20">
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
                className="flex w-full items-center justify-center gap-2 rounded-lg border border-white/10 bg-white/5 px-4 py-2.5 text-sm text-slate-300 transition-colors hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-60"
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
            <div className="rounded-lg bg-accent-500/10 p-2 text-accent-400 ring-1 ring-inset ring-accent-500/20">
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
            <div className="rounded-lg bg-accent-500/10 p-2 text-accent-400 ring-1 ring-inset ring-accent-500/20">
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
              <div className="rounded-lg bg-amber-500/10 p-2 text-amber-400 ring-1 ring-inset ring-amber-500/20">
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

        {role === "admin" && (
          <section>
            <div className="mb-4 flex items-center gap-3">
              <div className="rounded-lg bg-amber-500/10 p-2 text-amber-400 ring-1 ring-inset ring-amber-500/20">
                <Film size={18} />
              </div>
              <div>
                <h2 className="text-base font-semibold text-white">{t('settings.trailers.title')}</h2>
                <p className="text-xs text-slate-500">{t('settings.trailers.subtitle')}</p>
              </div>
            </div>
            <TrailerSettingsCard />
          </section>
        )}

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
        <div className="rounded-lg bg-accent-500/10 p-2 text-accent-400 ring-1 ring-inset ring-accent-500/20">
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
              className={[
                "rounded-lg border px-5 py-2 text-sm font-medium transition-colors",
                active === l
                  ? "border-accent-500 bg-accent-500/20 text-accent-300"
                  : "border-white/10 bg-white/5 text-slate-400 hover:bg-white/10 hover:text-white",
              ].join(" ")}
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
        className="flex items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-4 py-2 text-sm text-slate-300 hover:bg-white/10 transition-colors disabled:opacity-60"
      >
        <RefreshCw size={13} className={refreshing ? "animate-spin" : ""} />
        {refreshing ? t('settings.app.checking') : t('settings.app.updateButton')}
      </button>
    </div>
  );
}

interface TrailerStatus {
  autoPreviewEnabled: boolean;
  job: { status: "running" | "done" | "error"; total: number; completed: number; failed: number } | null;
}

// Auto-preview (see CinemaTrailerBackdrop.tsx) needs local trailer files to exist first — off by
// default, and the toggle itself stays disabled until a download job has actually completed
// (server-side enforced too, see /api/admin/trailers/toggle's own guard). Plain fetch + interval
// poll while a job is running, matching this page's own existing pattern (SessionsCard,
// PwaUpdateCard) rather than introducing SWR into a file that doesn't otherwise use it.
function TrailerSettingsCard() {
  const t = useT();
  const [status, setStatus] = useState<TrailerStatus | null>(null);
  const [starting, setStarting] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [toggling, setToggling] = useState(false);

  const refresh = useCallback(() => {
    fetch("/api/admin/trailers/status")
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => { if (j) setStatus(j); });
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  useEffect(() => {
    if (status?.job?.status !== "running") return;
    const interval = setInterval(refresh, 2000);
    return () => clearInterval(interval);
  }, [status?.job?.status, refresh]);

  async function downloadAll() {
    setStarting(true);
    try {
      const res = await fetch("/api/admin/trailers/download", { method: "POST" });
      if (res.ok) refresh();
    } finally {
      setStarting(false);
    }
  }

  async function cancel() {
    setCancelling(true);
    try {
      const res = await fetch("/api/admin/trailers/cancel", { method: "POST" });
      if (res.ok) refresh();
    } finally {
      setCancelling(false);
    }
  }

  async function toggleAuto(enabled: boolean) {
    setToggling(true);
    try {
      const res = await fetch("/api/admin/trailers/toggle", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }),
      });
      if (res.ok) refresh();
    } finally {
      setToggling(false);
    }
  }

  const job = status?.job ?? null;
  const running = job?.status === "running";
  const jobDone = job?.status === "done";
  const pct = job && job.total > 0 ? Math.round((job.completed / job.total) * 100) : 0;

  return (
    <div className="card p-5 space-y-4">
      <p className="text-xs leading-5 text-slate-500">{t('settings.trailers.explanation')}</p>

      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-2">
          <button
            onClick={downloadAll}
            disabled={running || starting}
            className="flex items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-4 py-2 text-sm text-slate-300 hover:bg-white/10 transition-colors disabled:opacity-60"
          >
            {running ? <Loader2 size={13} className="animate-spin" /> : <Film size={13} />}
            {running ? t('settings.trailers.downloading') : t('settings.trailers.downloadNow')}
          </button>
          {running && (
            <button
              onClick={cancel}
              disabled={cancelling}
              className="flex items-center gap-2 rounded-lg border border-red-500/20 bg-red-500/10 px-4 py-2 text-sm text-red-300 hover:bg-red-500/20 transition-colors disabled:opacity-60"
            >
              <CircleX size={13} />
              {t('settings.trailers.cancel')}
            </button>
          )}
        </div>

        <Toggle
          checked={status?.autoPreviewEnabled ?? false}
          onChange={toggleAuto}
          disabled={toggling || !jobDone}
          label={t('settings.trailers.toggleLabel')}
        />
      </div>

      {job && (
        <div>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/10">
            <div className="h-full bg-accent-500 transition-all" style={{ width: `${pct}%` }} />
          </div>
          <p className="mt-1.5 text-xs text-slate-500">
            {t('settings.trailers.progress', { completed: job.completed, total: job.total })}
            {job.failed > 0 && ` · ${t('settings.trailers.failedCount', { n: job.failed })}`}
          </p>
        </div>
      )}

      {!jobDone && <p className="text-xs text-slate-600">{t('settings.trailers.toggleDisabledHint')}</p>}
      {job && job.failed > 0 && (
        <p className="text-xs text-slate-600">{t('settings.trailers.cookiesHint')}</p>
      )}
    </div>
  );
}
