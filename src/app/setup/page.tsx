"use client";

import { useEffect, useMemo, useState } from "react";
import useSWR from "swr";
import { ArrowLeft, ArrowRight, Check, Loader2 } from "lucide-react";
import { useLocale, useT } from "@/components/TranslationProvider";
import { HelloIntro } from "@/components/setup/HelloIntro";
import { DeploymentGuide, SettingsGroupCard, type Draft } from "@/components/settings/SettingsGroupCard";
import { LOCALE_COOKIE, type Locale } from "@/lib/i18n";
import { SETTINGS_BY_KEY, type SettingGroup, type SettingView } from "@/lib/settings/schema";

/**
 * L'assistant de premier lancement (DECISIONS.md §48).
 *
 * Il s'ouvre tant que son drapeau n'est pas posé — le proxy y mène toute page — et ne se ferme qu'au
 * clic sur « Terminer ». Chaque étape enregistre ses réglages à « Suivant » : quitter au milieu ne
 * perd rien, et l'étape atteinte est retrouvée au retour. Ne sont obligatoires que Jellyfin, TMDB et
 * Radarr ou Sonarr ; le reste enrichit l'interface et se règle aussi plus tard, dans la gestion.
 */

type Status = { done: boolean; needsAdmin: boolean };
type SettingsPayload = { settings: SettingView[]; missing: string[]; setupDone: boolean };
type Step = "welcome" | "admin" | "jellyfin" | "tmdb" | "library" | "extras" | "deployment" | "finish";

const STEPS: Step[] = ["welcome", "admin", "jellyfin", "tmdb", "library", "extras", "deployment", "finish"];
const STEP_GROUPS: Partial<Record<Step, SettingGroup[]>> = {
  jellyfin: ["jellyfin"],
  tmdb: ["tmdb"],
  library: ["radarr", "sonarr"],
  extras: ["jellyseerr", "qbittorrent", "bazarr", "jackett", "ratings", "app"],
};
const STEP_STORAGE = "cine:setup-step";

/** Sans session, une 401 est attendue ici : pas de redirection vers la connexion. */
async function quietJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw Object.assign(new Error(String(res.status)), { status: res.status });
  return (await res.json()) as T;
}

function readStep(): number {
  try {
    const n = Number(localStorage.getItem(STEP_STORAGE));
    return Number.isInteger(n) && n >= 0 && n < STEPS.length ? n : 0;
  } catch {
    return 0;
  }
}
function writeStep(n: number) {
  try {
    localStorage.setItem(STEP_STORAGE, String(n));
  } catch {
    /* rien de grave : on repartira du début */
  }
}

export default function SetupPage() {
  const t = useT();
  const { locale } = useLocale();
  const { data: status, mutate: refreshStatus } = useSWR<Status>("/api/setup/status", quietJson);
  const { data: payload, error: settingsError, mutate: refreshSettings } = useSWR<SettingsPayload>(
    status && !status.needsAdmin ? "/api/settings" : null,
    quietJson,
  );
  const signedIn = !!payload;
  const [step, setStep] = useState(0);
  const [draft, setDraft] = useState<Draft>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [finished, setFinished] = useState(false);

  // L'étape atteinte, retrouvée au retour (lue une fois, après le montage : localStorage n'existe pas au rendu serveur).
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setStep(readStep());
  }, []);

  // Déjà terminé (et pas à l'instant, par nous) : rien à faire ici.
  useEffect(() => {
    if (status?.done && !finished) window.location.replace("/");
  }, [status?.done, finished]);

  const views = useMemo(() => new Map((payload?.settings ?? []).map((v) => [v.key, v])), [payload]);
  const current = STEPS[step];

  function go(n: number) {
    const next = Math.max(0, Math.min(STEPS.length - 1, n));
    setStep(next);
    writeStep(next);
    setErrors({});
    setProblem(null);
    window.scrollTo({ top: 0 });
  }

  async function chooseLanguage(l: Locale) {
    setBusy(true);
    await fetch("/api/setup/language", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ lang: l }) }).catch(() => null);
    document.cookie = `${LOCALE_COOKIE}=${l};path=/;max-age=${60 * 60 * 24 * 365};samesite=lax`;
    writeStep(1);
    // Le dictionnaire est rendu côté serveur : seul un rechargement le remplace vraiment.
    if (l !== locale) window.location.reload();
    else {
      setBusy(false);
      go(1);
    }
  }

  /** Enregistre les champs touchés des groupes de l'étape, puis avance. */
  async function saveAndNext(groups: SettingGroup[]) {
    const keys = (payload?.settings ?? []).map((v) => v.key);
    const values = Object.fromEntries(
      Object.entries(draft).filter(([k]) => keys.includes(k) && groups.some((g) => groupOf(k) === g)),
    );
    setBusy(true);
    setProblem(null);
    try {
      if (Object.keys(values).length > 0) {
        const res = await fetch("/api/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ values }) });
        const body = (await res.json().catch(() => null)) as (SettingsPayload & { errors?: Record<string, string> }) | null;
        if (!res.ok) {
          setErrors(body?.errors ?? {});
          setProblem(t("setup.errors.save"));
          return;
        }
        await refreshSettings();
        setDraft((d) => Object.fromEntries(Object.entries(d).filter(([k]) => !(k in values))));
      }
      const fresh = await refreshSettings();
      const missing = (fresh?.missing ?? []).filter((m) => stepNeeds(groups, m));
      if (missing.length > 0) {
        setProblem(t("setup.missing", { list: missing.map((m) => labelOfMissing(m, t)).join(", ") }));
        return;
      }
      go(step + 1);
    } finally {
      setBusy(false);
    }
  }

  async function reset(key: string) {
    await fetch(`/api/settings?key=${encodeURIComponent(key)}`, { method: "DELETE" }).catch(() => null);
    setDraft((d) => Object.fromEntries(Object.entries(d).filter(([k]) => k !== key)));
    await refreshSettings();
  }

  async function finish() {
    setBusy(true);
    setProblem(null);
    try {
      const res = await fetch("/api/setup/complete", { method: "POST" });
      const body = (await res.json().catch(() => null)) as { missing?: string[] } | null;
      if (!res.ok) {
        setProblem(t("setup.missing", { list: (body?.missing ?? []).map((m) => labelOfMissing(m, t)).join(", ") }));
        return;
      }
      setFinished(true);
      writeStep(0);
      await refreshStatus();
    } finally {
      setBusy(false);
    }
  }

  if (!status) {
    return (
      <Shell>
        <Loader2 className="mx-auto animate-spin text-subtle" />
      </Shell>
    );
  }

  if (finished) {
    return (
      <Shell>
        <div className="text-center">
          <div className="mx-auto mb-5 flex h-14 w-14 items-center justify-center rounded-full bg-success/15 text-success">
            <Check size={28} />
          </div>
          <h1 className="mb-2 font-display text-3xl font-semibold text-white">{t("setup.done.title")}</h1>
          <p className="mb-8 text-sm text-muted">{t("setup.done.text")}</p>
          <div className="flex flex-col gap-2.5 sm:flex-row sm:justify-center">
            <a href="/gestion" className="btn btn-primary justify-center">{t("setup.done.manage")}</a>
            <a href="/login" className="btn btn-ghost justify-center">{t("setup.done.cinema")}</a>
          </div>
        </div>
      </Shell>
    );
  }

  const groups = STEP_GROUPS[current];
  return (
    <Shell>
      {current !== "welcome" && (
        <>
          <p className="mb-1 text-xs font-medium uppercase tracking-wide text-subtle">
            {t("setup.progress", { n: step, total: STEPS.length - 1 })} · {t(`setup.steps.${current}`)}
          </p>
          <div className="mb-6 flex gap-1">
            {STEPS.slice(1).map((s, i) => (
              <span key={s} className={`h-1 flex-1 rounded-full ${i < step ? "bg-accent-500" : "bg-white/10"}`} />
            ))}
          </div>
        </>
      )}

      {current === "welcome" && (
        <>
          <HelloIntro current={locale} busy={busy ? locale : null} onChoose={chooseLanguage} />
          <p className="mx-auto mt-8 max-w-md text-center text-sm text-muted">{t("setup.welcome.text")}</p>
        </>
      )}

      {current === "admin" && (
        <AdminStep
          needsAdmin={status.needsAdmin}
          signedIn={signedIn}
          checking={!status.needsAdmin && !payload && !settingsError}
          onCreated={async () => {
            await refreshStatus();
            await refreshSettings();
            go(step + 1);
          }}
          onNext={() => go(step + 1)}
        />
      )}

      {groups && signedIn && (
        <div className="space-y-4">
          {current === "jellyfin" && <p className="text-sm text-subtle">{t("setup.welcome.urls")} {t("setup.welcome.env")}</p>}
          {current === "library" && <p className="text-sm text-warning">{t("setup.libraryRule")}</p>}
          {groups.map((g) => (
            <SettingsGroupCard
              key={g}
              group={g}
              views={views}
              draft={draft}
              errors={errors}
              onDraft={(k, v) => setDraft((d) => ({ ...d, [k]: v }))}
              onReset={reset}
            />
          ))}
        </div>
      )}
      {groups && !signedIn && <NeedSignIn />}

      {current === "deployment" && <DeploymentGuide />}

      {current === "finish" && (
        <div>
          <h2 className="mb-2 text-xl font-semibold text-white">{t("setup.steps.finish")}</h2>
          <p className="text-sm text-muted">{t("setup.done.text")}</p>
          {payload && payload.missing.length > 0 && (
            <p className="mt-3 text-sm text-danger">{t("setup.missing", { list: payload.missing.map((m) => labelOfMissing(m, t)).join(", ") })}</p>
          )}
        </div>
      )}

      {problem && <p className="mt-4 text-sm text-danger">{problem}</p>}

      {current !== "welcome" && (
        <nav className="mt-8 flex items-center justify-between gap-3">
          <button type="button" onClick={() => go(step - 1)} className="btn btn-ghost">
            <ArrowLeft size={16} /> {t("setup.back")}
          </button>
          {current === "finish" ? (
            <button type="button" onClick={finish} disabled={busy || !signedIn || (payload?.missing.length ?? 1) > 0} className="btn btn-primary">
              {busy ? <Loader2 size={16} className="animate-spin" /> : <Check size={16} />}
              {busy ? t("setup.done.finishing") : t("setup.finish")}
            </button>
          ) : groups ? (
            <button type="button" onClick={() => saveAndNext(groups)} disabled={busy || !signedIn} className="btn btn-primary">
              {busy ? <Loader2 size={16} className="animate-spin" /> : null}
              {busy ? t("setup.saving") : t("setup.next")} {!busy && <ArrowRight size={16} />}
            </button>
          ) : current === "deployment" ? (
            <button type="button" onClick={() => go(step + 1)} className="btn btn-primary">
              {t("setup.next")} <ArrowRight size={16} />
            </button>
          ) : null}
        </nav>
      )}
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  const t = useT();
  return (
    <main className="min-h-dvh bg-ink px-5 py-10" style={{ paddingBottom: "max(2.5rem, calc(env(safe-area-inset-bottom, 0px) + 1rem))" }}>
      <div className="mx-auto w-full max-w-xl">
        <header className="mb-8 text-center">
          <p className="font-display text-sm font-semibold tracking-tight text-accent-400">CineApp</p>
          <p className="mt-1 text-xs text-subtle">{t("setup.subtitle")}</p>
        </header>
        {children}
      </div>
    </main>
  );
}

function NeedSignIn() {
  const t = useT();
  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-5 text-center">
      <h2 className="mb-2 text-lg font-semibold text-white">{t("setup.admin.signInTitle")}</h2>
      <p className="mb-5 text-sm text-muted">{t("setup.admin.signInText")}</p>
      <a href="/login?next=/setup" className="btn btn-primary justify-center">{t("setup.admin.signIn")}</a>
    </div>
  );
}

function AdminStep({
  needsAdmin,
  signedIn,
  checking,
  onCreated,
  onNext,
}: {
  needsAdmin: boolean;
  signedIn: boolean;
  checking: boolean;
  onCreated: () => Promise<void>;
  onNext: () => void;
}) {
  const t = useT();
  const [username, setUsername] = useState("admin");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (checking) return <Loader2 className="mx-auto animate-spin text-subtle" />;
  if (!needsAdmin && !signedIn) return <NeedSignIn />;
  if (!needsAdmin && signedIn) {
    // Le compte existe et la session est ouverte : rien à créer.
    return (
      <div className="text-center">
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-success/15 text-success">
          <Check size={24} />
        </div>
        <h2 className="mb-6 text-lg font-semibold text-white">{t("setup.admin.title")}</h2>
        <button type="button" onClick={onNext} className="btn btn-primary">
          {t("setup.next")} <ArrowRight size={16} />
        </button>
      </div>
    );
  }

  async function create(e: React.FormEvent) {
    e.preventDefault();
    if (password.length < 8) return setError(t("setup.admin.weak"));
    if (password !== confirm) return setError(t("setup.admin.mismatch"));
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/setup/admin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: username.trim(), password }),
      });
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      if (!res.ok) {
        setError(body?.error === "invalid-username" ? t("setup.admin.invalidUsername") : body?.error === "weak-password" ? t("setup.admin.weak") : t("setup.errors.save"));
        return;
      }
      await onCreated();
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={create} className="rounded-2xl border border-white/10 bg-white/[0.03] p-5">
      <h2 className="mb-1 text-lg font-semibold text-white">{t("setup.admin.title")}</h2>
      <p className="mb-5 text-sm text-muted">{t("setup.admin.text")}</p>
      <label className="mb-1.5 block text-sm font-medium text-white" htmlFor="setup-user">{t("setup.admin.username")}</label>
      <input id="setup-user" className="input mb-4" autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} />
      <label className="mb-1.5 block text-sm font-medium text-white" htmlFor="setup-pass">{t("setup.admin.password")}</label>
      <input id="setup-pass" className="input mb-4" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
      <label className="mb-1.5 block text-sm font-medium text-white" htmlFor="setup-confirm">{t("setup.admin.confirm")}</label>
      <input id="setup-confirm" className="input" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
      {error && <p className="mt-3 text-sm text-danger">{error}</p>}
      <button type="submit" disabled={busy} className="btn btn-primary mt-5 w-full justify-center">
        {busy ? <Loader2 size={16} className="animate-spin" /> : null}
        {t("setup.admin.create")}
      </button>
    </form>
  );
}

// ─── Petites aides ───────────────────────────────────────────────────────────

function groupOf(key: string): SettingGroup | undefined {
  return SETTINGS_BY_KEY.get(key)?.group;
}
/** Ce qui manque concerne-t-il cette étape ? */
function stepNeeds(groups: SettingGroup[], missing: string): boolean {
  if (missing === "RADARR_API_KEY|SONARR_API_KEY") return groups.includes("radarr") || groups.includes("sonarr");
  const g = groupOf(missing);
  return !!g && groups.includes(g);
}
function labelOfMissing(missing: string, t: (key: string) => string): string {
  if (missing === "RADARR_API_KEY|SONARR_API_KEY") return t("setup.need.library");
  return t(`setup.fields.${missing}`);
}
