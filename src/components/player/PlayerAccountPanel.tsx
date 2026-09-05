"use client";

import { useEffect, useState } from "react";
import useSWR from "swr";
import { useRouter } from "next/navigation";
import { LogOut, Languages, Subtitles, Bell, KeyRound, MonitorSmartphone } from "lucide-react";
import { fetcher } from "@/lib/swr";
import { apiAction } from "@/lib/apiAction";
import { LOCALES, LOCALE_LABELS, type Locale } from "@/lib/i18n";
import { useLocale, useT } from "@/components/TranslationProvider";
import { useToast } from "@/components/Toast";
import { PushToggle } from "@/components/PushToggle";
import { PlayerPanelFrame } from "./PlayerPanelFrame";
import type { PlayerPreferences } from "@/app/api/player/account/preferences/route";

/**
 * Le compte, en une feuille.
 *
 * C'est un sous-ensemble de `/parametres`, redessiné dans la langue du lecteur : rien de ce qui
 * touche à l'infrastructure, rien qui parle d'un service par son nom. Ce qui s'y ajoute est ce
 * qui manquait vraiment — changer son mot de passe, que personne ne pouvait faire depuis
 * l'application.
 */
function Section({ icon: Icon, title, children }: { icon: React.ElementType; title: string; children: React.ReactNode }) {
  return (
    // `py-7` debout, moitié moins couché : cinq sections à sept rems d'écart font descendre
    // « Déconnexion » très loin sur un écran de 390 px.
    <section className="border-t border-white/10 py-7 first:border-t-0 first:pt-0 [@media(max-height:500px)]:py-4">
      <h2 className="mb-4 flex items-center gap-2.5 text-sm font-semibold text-white [@media(max-height:500px)]:mb-2.5">
        <Icon size={16} className="text-slate-500" />
        {title}
      </h2>
      {children}
    </section>
  );
}

export function PlayerAccountPanel({ leaving }: { leaving?: boolean }) {
  const t = useT();
  const router = useRouter();
  const { data: me } = useSWR<{ username: string; jfUser: string | null }>("/api/auth/me", fetcher);
  // La connexion locale (celle de l'administrateur) n'a pas de compte Jellyfin derrière elle :
  // ni préférences de lecture, ni mot de passe à changer de ce côté. Le dire une fois vaut mieux
  // que trois listes déroulantes grisées sans explication.
  const hasJellyfin = me?.jfUser != null;

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.replace("/login");
  }

  return (
    <PlayerPanelFrame
      leaving={leaving}
      title={t("player.nav.account")}
      subtitle={me?.jfUser || me?.username || undefined}
    >
      <div className="mx-auto w-full max-w-2xl">
        <LanguageSection />
        {hasJellyfin && <PlaybackSection />}

        <Section icon={Bell} title={t("player.account.notifications")}>
          <div className="flex items-center justify-between gap-4 rounded-xl border border-white/10 bg-white/5 px-4 py-3.5">
            <div>
              <p className="text-sm text-white">{t("player.account.notificationsLabel")}</p>
              <p className="mt-0.5 text-xs text-slate-500">{t("player.account.notificationsHint")}</p>
            </div>
            <PushToggle />
          </div>
        </Section>

        {hasJellyfin ? (
          <PasswordSection />
        ) : (
          <Section icon={KeyRound} title={t("player.account.password")}>
            <p className="text-sm text-slate-400">{t("player.account.localAccountHint")}</p>
          </Section>
        )}
        <SessionsSection />

        <Section icon={LogOut} title={t("player.account.signOut")}>
          <button type="button" onClick={logout} className="btn btn-ghost w-full justify-center text-red-400 sm:w-auto">
            <LogOut size={16} />
            {t("player.account.signOutAction")}
          </button>
        </Section>
      </div>
    </PlayerPanelFrame>
  );
}

function LanguageSection() {
  const t = useT();
  const { locale, setLocale } = useLocale();
  const [pending, setPending] = useState<Locale | null>(null);
  const active = pending ?? locale;

  async function apply() {
    if (!pending) return;
    await setLocale(pending);
    // Le dictionnaire est rendu côté serveur : seul un rechargement le remplace vraiment.
    setTimeout(() => window.location.reload(), 80);
  }

  return (
    <Section icon={Languages} title={t("player.account.language")}>
      <div className="flex flex-wrap gap-2.5">
        {LOCALES.map((l) => (
          <button
            key={l}
            type="button"
            onClick={() => l !== locale && setPending(l)}
            className={`chip px-5 py-2 ${active === l ? "chip-on" : ""}`}
          >
            {LOCALE_LABELS[l]}
          </button>
        ))}
      </div>
      {pending && pending !== locale && (
        <div className="mt-4 flex items-center justify-between gap-4 rounded-xl border border-amber-500/20 bg-amber-500/10 px-4 py-3">
          <p className="text-xs text-amber-300">{t("settings.language.reloadNotice", { lang: LOCALE_LABELS[pending] })}</p>
          <button onClick={apply} className="btn btn-sm shrink-0 bg-amber-500 text-black hover:bg-amber-400">
            {t("settings.language.apply")}
          </button>
        </div>
      )}
    </Section>
  );
}

// Les codes que Jellyfin attend (ISO 639-2/B), et les mots qu'on affiche à la place.
const AUDIO_CHOICES = ["", "fre", "eng", "spa", "ger", "ita", "jpn"] as const;
const SUBTITLE_MODES = ["Default", "Always", "OnlyForced", "None"] as const;

function PlaybackSection() {
  const t = useT();
  const toast = useToast();
  const { data, mutate } = useSWR<PlayerPreferences>("/api/player/account/preferences", fetcher, {
    revalidateOnFocus: false,
  });
  const [saving, setSaving] = useState(false);

  async function save(patch: Partial<PlayerPreferences>) {
    if (saving) return;
    setSaving(true);
    try {
      await apiAction("/api/player/account/preferences", { method: "POST", body: JSON.stringify(patch) });
      await mutate();
      toast.success(t("player.account.saved"));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("common.unknown"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Section icon={Subtitles} title={t("player.account.playback")}>
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="flex flex-col gap-1.5">
          <span className="text-xs text-slate-400">{t("player.account.audioLanguage")}</span>
          <select
            className="select"
            disabled={saving || !data}
            value={data?.audioLanguage ?? ""}
            onChange={(e) => void save({ audioLanguage: e.target.value || null })}
          >
            {AUDIO_CHOICES.map((code) => (
              <option key={code || "none"} value={code}>
                {code ? t(`player.account.lang.${code}`) : t("player.account.langAny")}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1.5">
          <span className="text-xs text-slate-400">{t("player.account.subtitleLanguage")}</span>
          <select
            className="select"
            disabled={saving || !data}
            value={data?.subtitleLanguage ?? ""}
            onChange={(e) => void save({ subtitleLanguage: e.target.value || null })}
          >
            {AUDIO_CHOICES.map((code) => (
              <option key={code || "none"} value={code}>
                {code ? t(`player.account.lang.${code}`) : t("player.account.langAny")}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1.5 sm:col-span-2">
          <span className="text-xs text-slate-400">{t("player.account.subtitleMode")}</span>
          <select
            className="select"
            disabled={saving || !data}
            value={data?.subtitleMode ?? "Default"}
            onChange={(e) => void save({ subtitleMode: e.target.value })}
          >
            {SUBTITLE_MODES.map((mode) => (
              <option key={mode} value={mode}>
                {t(`player.account.subtitleModes.${mode}`)}
              </option>
            ))}
          </select>
        </label>
      </div>
      <p className="mt-3 text-xs text-slate-500">{t("player.account.playbackHint")}</p>
    </Section>
  );
}

function PasswordSection() {
  const t = useT();
  const toast = useToast();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [saving, setSaving] = useState(false);

  const mismatch = confirm.length > 0 && next !== confirm;
  const canSubmit = current.length > 0 && next.length >= 8 && !mismatch && !saving;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setSaving(true);
    try {
      await apiAction("/api/player/account/password", {
        method: "POST",
        body: JSON.stringify({ currentPassword: current, newPassword: next }),
      });
      toast.success(t("player.account.passwordChanged"));
      setCurrent("");
      setNext("");
      setConfirm("");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("common.unknown"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Section icon={KeyRound} title={t("player.account.password")}>
      <form onSubmit={submit} className="grid gap-3 sm:grid-cols-2">
        <input
          className="input sm:col-span-2"
          type="password"
          autoComplete="current-password"
          placeholder={t("player.account.currentPassword")}
          value={current}
          onChange={(e) => setCurrent(e.target.value)}
        />
        <input
          className="input"
          type="password"
          autoComplete="new-password"
          placeholder={t("player.account.newPassword")}
          value={next}
          onChange={(e) => setNext(e.target.value)}
        />
        <input
          className="input"
          type="password"
          autoComplete="new-password"
          placeholder={t("player.account.confirmPassword")}
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
        />
        <div className="flex items-center gap-3 sm:col-span-2">
          <button type="submit" disabled={!canSubmit} className="btn btn-primary btn-sm">
            {saving ? t("player.account.saving") : t("player.account.changePassword")}
          </button>
          <p className="text-xs text-slate-500">
            {mismatch ? t("player.account.passwordMismatch") : t("player.account.passwordRule")}
          </p>
        </div>
      </form>
    </Section>
  );
}

function SessionsSection() {
  const t = useT();
  const toast = useToast();
  const [count, setCount] = useState<number | null>(null);
  const [revoking, setRevoking] = useState(false);

  useEffect(() => {
    let alive = true;
    fetch("/api/auth/sessions")
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (alive && j != null) setCount(j.count);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  async function revoke() {
    setRevoking(true);
    try {
      await apiAction("/api/auth/sessions", { method: "DELETE" });
      setCount(0);
      toast.success(t("player.account.devicesRevoked"));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("common.unknown"));
    } finally {
      setRevoking(false);
    }
  }

  return (
    <Section icon={MonitorSmartphone} title={t("player.account.devices")}>
      <div className="flex items-center justify-between gap-4 rounded-xl border border-white/10 bg-white/5 px-4 py-3.5">
        <p className="text-sm text-slate-300">
          {count === null
            ? t("settings.security.loading")
            : count === 0
            ? t("player.account.noOtherDevices")
            : t("player.account.otherDevices", { n: count })}
        </p>
        <button
          type="button"
          onClick={revoke}
          disabled={revoking || count === 0 || count === null}
          className="btn btn-ghost btn-sm shrink-0 text-red-400"
        >
          {t("player.account.signOutOthers")}
        </button>
      </div>
    </Section>
  );
}
