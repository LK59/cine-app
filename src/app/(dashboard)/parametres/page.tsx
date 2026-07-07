"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Bell, CheckCircle, Loader2, Moon, Palette, Send, Settings, XCircle } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { PushToggle } from "@/components/PushToggle";
import { Toggle } from "@/components/Toggle";
import { NOTIFICATION_CATEGORIES, getDefaultNotificationPreferences, type NotificationCategory } from "@/lib/notifications";
import { useTheme } from "@/components/ThemeProvider";
import { ACCENT_PRESETS } from "@/lib/theme";

type TestState = "idle" | "sending" | "sent" | "error";

export default function ParametresPage() {
  const { accent, amoled, setAccent, setAmoled } = useTheme();

  // Notification state
  const [preferences, setPreferences] = useState<Record<NotificationCategory, boolean>>(getDefaultNotificationPreferences);
  const [loadingPrefs, setLoadingPrefs] = useState(true);
  const [saving, setSaving] = useState<NotificationCategory | null>(null);
  const [testState, setTestState] = useState<TestState>("idle");
  const [countdown, setCountdown] = useState<number | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    fetch("/api/notifications/settings")
      .then((res) => (res.ok ? res.json() : null))
      .then((json) => { if (json?.preferences) setPreferences(json.preferences); })
      .finally(() => setLoadingPrefs(false));
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
        title="Paramètres"
        subtitle="Personnalise l'apparence et les notifications"
      />

      <div className="space-y-8">

        {/* ── Apparence ── */}
        <section>
          <div className="mb-4 flex items-center gap-3">
            <div className="rounded-lg bg-accent-500/10 p-2 text-accent-400 ring-1 ring-inset ring-accent-500/20">
              <Palette size={18} />
            </div>
            <div>
              <h2 className="text-base font-semibold text-white">Apparence</h2>
              <p className="text-xs text-slate-500">Couleur d'accent et mode d'affichage</p>
            </div>
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            {/* Accent color picker */}
            <div className="card p-5">
              <p className="mb-4 text-sm font-medium text-white">Couleur d'accent</p>
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
                          "flex h-10 w-10 items-center justify-center rounded-full transition-all duration-200",
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
                    <p className="text-sm font-medium text-white">Mode ultra-sombre</p>
                    <p className="mt-1 text-xs leading-5 text-slate-500">
                      Fond noir pur (#000000). Sur écran OLED, les pixels noirs sont éteints — économie de batterie et contraste maximal la nuit.
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
              <h2 className="text-base font-semibold text-white">Notifications</h2>
              <p className="text-xs text-slate-500">Alertes push par appareil et par catégorie</p>
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
                    <p className="text-sm font-semibold text-white">Cet appareil</p>
                    <p className="mt-0.5 text-xs text-slate-500">L'activation reste propre à chaque navigateur ou PWA installée.</p>
                  </div>
                </div>
                <div className="flex items-center justify-between gap-4">
                  <div>
                    <p className="text-sm font-medium text-white">Notifications push</p>
                    <p className="mt-0.5 text-xs text-slate-500">Active ou désactive cet appareil.</p>
                  </div>
                  <PushToggle />
                </div>
              </div>

              <div className="card p-5">
                <div className="mb-5">
                  <p className="text-sm font-semibold text-white">Catégories</p>
                  <p className="mt-0.5 text-xs text-slate-500">Choisis les alertes que tu veux recevoir.</p>
                </div>
                <div className="divide-y divide-white/5">
                  {NOTIFICATION_CATEGORIES.map((category) => (
                    <div key={category.id} className="flex items-center justify-between gap-4 py-3 first:pt-0 last:pb-0">
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-white">{category.label}</p>
                        <p className="mt-0.5 text-xs text-slate-500">{category.description}</p>
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
                <p className="text-sm font-semibold text-white">Test</p>
                <p className="mt-0.5 text-xs text-slate-500">Envoie une notification de test dans 5 secondes.</p>
              </div>
              <button
                onClick={startTest}
                disabled={countdown !== null || testState === "sending"}
                className="flex w-full items-center justify-center gap-2 rounded-lg border border-white/10 bg-white/5 px-4 py-2.5 text-sm text-slate-300 transition-colors hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {countdown !== null || testState === "sending" ? (
                  <><Loader2 size={15} className="animate-spin" />{countdown !== null ? `Envoi dans ${countdown}s` : "Envoi…"}</>
                ) : (
                  <><Send size={15} />Tester</>
                )}
              </button>
              {testState === "sent" && (
                <p className="mt-3 flex items-center gap-1.5 text-xs text-emerald-400"><CheckCircle size={13} /> Notification envoyée</p>
              )}
              {testState === "error" && (
                <p className="mt-3 flex items-center gap-1.5 text-xs text-red-400"><XCircle size={13} /> Envoi impossible</p>
              )}
            </div>
          </div>
        </section>

      </div>
    </div>
  );
}
