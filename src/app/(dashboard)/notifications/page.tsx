"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Bell, CheckCircle, Loader2, Send, XCircle } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { PushToggle } from "@/components/PushToggle";
import { Toggle } from "@/components/Toggle";
import { NOTIFICATION_CATEGORIES, getDefaultNotificationPreferences, type NotificationCategory } from "@/lib/notifications";
import { useT } from "@/components/TranslationProvider";

type TestState = "idle" | "sending" | "sent" | "error";

export default function NotificationsPage() {
  const t = useT();
  const [preferences, setPreferences] = useState<Record<NotificationCategory, boolean>>(getDefaultNotificationPreferences);
  const [loadingPrefs, setLoadingPrefs] = useState(true);
  const [saving, setSaving] = useState<NotificationCategory | null>(null);
  const [testState, setTestState] = useState<TestState>("idle");
  const [countdown, setCountdown] = useState<number | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    fetch("/api/notifications/settings")
      .then((res) => res.ok ? res.json() : null)
      .then((json) => {
        if (json?.preferences) setPreferences(json.preferences);
      })
      .finally(() => setLoadingPrefs(false));
  }, []);

  const savePreference = useCallback(async (category: NotificationCategory, enabled: boolean) => {
    setPreferences((current) => ({ ...current, [category]: enabled }));
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

  useEffect(() => {
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, []);

  return (
    <div>
      <PageHeader
        title={t('notifications.pageTitle')}
        subtitle={t('notifications.subtitle')}
      />

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
        <div className="space-y-4">
          <section className="card p-5">
            <div className="mb-5 flex items-start gap-3">
              <div className="rounded-lg bg-accent-500/10 p-2 text-accent-400 ring-1 ring-inset ring-accent-500/20">
                <Bell size={18} />
              </div>
              <div>
                <h2 className="text-base font-semibold text-white">{t('notifications.thisDevice')}</h2>
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
          </section>

          <section className="card p-5">
            <div className="mb-5">
              <h2 className="text-base font-semibold text-white">{t('notifications.categories')}</h2>
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
          </section>
        </div>

        <aside className="card h-fit p-5">
          <div className="mb-5">
            <h2 className="text-base font-semibold text-white">{t('notifications.test')}</h2>
            <p className="mt-0.5 text-xs text-slate-500">{t('notifications.testDescription')}</p>
          </div>
          <button
            onClick={startTest}
            disabled={countdown !== null || testState === "sending"}
            className="flex w-full items-center justify-center gap-2 rounded-lg border border-white/10 bg-white/5 px-4 py-2.5 text-sm text-slate-300 transition-colors hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {countdown !== null || testState === "sending" ? (
              <>
                <Loader2 size={15} className="animate-spin" />
                {countdown !== null ? t('notifications.sendingIn', { n: countdown }) : t('notifications.sending')}
              </>
            ) : (
              <>
                <Send size={15} />
                {t('notifications.testButton')}
              </>
            )}
          </button>
          {testState === "sent" && (
            <p className="mt-3 flex items-center gap-1.5 text-xs text-emerald-400"><CheckCircle size={13} /> {t('notifications.sent')}</p>
          )}
          {testState === "error" && (
            <p className="mt-3 flex items-center gap-1.5 text-xs text-red-400"><XCircle size={13} /> {t('notifications.sendError')}</p>
          )}
        </aside>
      </div>
    </div>
  );
}
