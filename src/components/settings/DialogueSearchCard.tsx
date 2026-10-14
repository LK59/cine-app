"use client";

import { useState } from "react";
import useSWR from "swr";
import { Loader2, Pause, Play, RotateCcw, Zap } from "lucide-react";
import { fetcher } from "@/lib/swr";
import { fmtEta, fmtSize } from "@/lib/format";
import { useT } from "@/components/TranslationProvider";
import { useToast } from "@/components/Toast";
import { ErrorState } from "@/components/StateViews";
import { LANGUAGE_CHOICES, parseLanguageSetting } from "@/lib/repliques/languages";
import type { RepliquesStatus } from "@/lib/repliques/engine";

/**
 * Configuration → Recherche de répliques (DECISIONS.md §88).
 *
 * Trois choses, dans l'ordre où on les règle : l'option (grisée tant que le dossier des films n'est
 * pas monté et lisible — et la raison est dite), l'**indexation initiale** (un bouton, et sa
 * progression qui se rafraîchit d'elle-même), puis la **mise à jour de nuit** et les langues. L'index
 * lui-même — sa taille, « Reconstruire » — et les erreurs par film viennent en dernier.
 *
 * Les réglages passent par `/api/settings` comme tous les autres (§48) ; les gestes par
 * `/api/repliques/admin`. Le serveur refuse lui aussi d'allumer l'option sans montage.
 */

const HOURS = Array.from({ length: 24 }, (_, h) => h);
const ACTIVE: RepliquesStatus["phase"][] = ["planning", "running", "waiting-playback"];

export function DialogueSearchCard() {
  const t = useT();
  const toast = useToast();
  const { data, error, mutate } = useSWR<RepliquesStatus>("/api/repliques/admin", fetcher, {
    // Pendant une passe, la progression bouge : rafraîchie toutes les trois secondes ; sinon au calme.
    refreshInterval: (latest) => (latest && ACTIVE.includes(latest.phase) ? 3000 : 20_000),
  });
  const [busy, setBusy] = useState<string | null>(null);
  const [draft, setDraft] = useState<{ nightly?: boolean; start?: number; end?: number; languages?: string[] }>({});

  if (!data && error) return <ErrorState message={t("common.error")} onRetry={() => void mutate()} />;
  if (!data) return <Loader2 className="animate-spin text-subtle" />;

  const mountOk = data.mount.ok;
  const running = ACTIVE.includes(data.phase);
  const run = data.run;
  const unfinished = !!run && run.finishedAt === null;
  // « Forcer » n'a de sens que pour une passe initiale inachevée : la nuit tourne hors des lectures.
  const canForce = unfinished && run?.kind === "initial";
  const phaseLabel = data.forced && data.phase === "running" ? "running-forced" : data.phase;
  const percent = run && run.total > 0 ? Math.min(100, Math.round((run.done / run.total) * 100)) : run?.finishedAt ? 100 : 0;

  const nightly = draft.nightly ?? data.settings.nightly;
  const start = draft.start ?? data.settings.nightStart;
  const end = draft.end ?? data.settings.nightEnd;
  const languages = draft.languages ?? parseLanguageSetting(data.settings.languages);
  const dirty = Object.keys(draft).length > 0;

  async function saveSettings(values: Record<string, string>): Promise<boolean> {
    const res = await fetch("/api/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ values }) }).catch(() => null);
    if (!res?.ok) {
      const body = (await res?.json().catch(() => null)) as { errors?: Record<string, string> } | null;
      toast.error(body?.errors?.REPLIQUES_ENABLED === "unavailable" ? t("repliques.admin.mountRequired") : t("setup.errors.save"));
      return false;
    }
    return true;
  }

  async function toggleEnabled(on: boolean) {
    setBusy("enable");
    if (await saveSettings({ REPLIQUES_ENABLED: on ? "true" : "false" })) toast.success(t("setup.saved"));
    setBusy(null);
    await mutate();
  }

  async function saveSchedule() {
    setBusy("schedule");
    const ok = await saveSettings({
      REPLIQUES_NIGHTLY: nightly ? "true" : "false",
      REPLIQUES_NIGHT_START: String(start),
      REPLIQUES_NIGHT_END: String(end),
      REPLIQUES_LANGUAGES: languages.join(","),
    });
    if (ok) {
      setDraft({});
      toast.success(t("setup.saved"));
    }
    setBusy(null);
    await mutate();
  }

  async function act(action: "start" | "pause" | "rebuild" | "force" | "unforce") {
    if (action === "rebuild" && !window.confirm(t("repliques.admin.rebuildConfirm"))) return;
    setBusy(action);
    const res = await fetch("/api/repliques/admin", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action }) }).catch(() => null);
    setBusy(null);
    if (!res?.ok) toast.error(t("repliques.admin.actionFailed"));
    await mutate();
  }

  const toggleLanguage = (code: string) =>
    setDraft((d) => {
      const current = d.languages ?? languages;
      const next = current.includes(code) ? current.filter((c) => c !== code) : [...current, code];
      return { ...d, languages: next.length > 0 ? next : current };
    });

  return (
    <div className="space-y-4">
      {/* L'option. */}
      <section className="settings-card rounded-2xl border border-white/10 bg-white/[0.03] p-4 sm:p-5">
        <h3 className="text-base font-semibold text-white">{t("repliques.admin.title")}</h3>
        <p className="mt-1 text-sm text-muted">{t("repliques.admin.why")}</p>
        <div className="mt-4 flex flex-wrap items-center gap-1.5" role="radiogroup" aria-label={t("repliques.admin.title")}>
          {([true, false] as const).map((on) => (
            <button
              key={String(on)}
              type="button"
              role="radio"
              aria-checked={data.enabled === on}
              disabled={busy !== null || (on && !mountOk && !data.enabled)}
              onClick={() => data.enabled !== on && void toggleEnabled(on)}
              className={`chip ${data.enabled === on ? "chip-on" : ""} disabled:opacity-40`}
            >
              {t(on ? "setup.on" : "setup.off")}
            </button>
          ))}
        </div>
        {!mountOk && (
          <div className="mt-3 rounded-xl bg-warning/10 px-4 py-3 text-sm text-warning">
            <p>{t(`repliques.admin.mount.${data.mount.problem ?? "not-mounted"}`, { path: data.mount.moviesPath })}</p>
            <p className="mt-1 text-xs text-muted">{t("repliques.admin.mountDoc")}</p>
          </div>
        )}
        {mountOk && (
          <p className="mt-3 text-xs text-subtle">
            {t("repliques.admin.mountOk", { path: data.mount.moviesPath, found: data.mount.sample.found, checked: data.mount.sample.checked })}
          </p>
        )}
      </section>

      {data.enabled && (
        <>
          {/* L'indexation initiale. */}
          <section className="settings-card rounded-2xl border border-white/10 bg-white/[0.03] p-4 sm:p-5">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h3 className="text-base font-semibold text-white">{t("repliques.admin.initialTitle")}</h3>
                <p className="mt-1 text-sm text-muted">{t(`repliques.admin.phase.${phaseLabel}`)}</p>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {canForce && (
                  <button
                    type="button"
                    aria-pressed={data.forced}
                    className={`btn btn-sm rounded-full ${data.forced ? "btn-primary" : ""}`}
                    disabled={busy !== null}
                    onClick={() => void act(data.forced ? "unforce" : "force")}
                  >
                    {busy === "force" || busy === "unforce" ? <Loader2 size={14} className="animate-spin" /> : <Zap size={14} />}
                    {t(data.forced ? "repliques.admin.unforce" : "repliques.admin.force")}
                  </button>
                )}
                {running ? (
                  <button type="button" className="btn btn-sm rounded-full" disabled={busy !== null} onClick={() => void act("pause")}>
                    <Pause size={14} />
                    {t("repliques.admin.pause")}
                  </button>
                ) : (
                  <button type="button" className="btn btn-primary btn-sm rounded-full" disabled={busy !== null || !mountOk} onClick={() => void act("start")}>
                    {busy === "start" ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
                    {unfinished ? t("repliques.admin.resume") : data.initialDone ? t("repliques.admin.update") : t("repliques.admin.start")}
                  </button>
                )}
              </div>
            </div>
            {canForce && <p className={`mt-2 text-xs ${data.forced ? "text-warning" : "text-subtle"}`}>{t(data.forced ? "repliques.admin.forcedNote" : "repliques.admin.forceWarning")}</p>}
            {run && (
              <div className="mt-4 space-y-2">
                <div className="h-2 overflow-hidden rounded-full bg-white/10" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
                  <div className="h-full rounded-full bg-white transition-[width] duration-500" style={{ width: `${percent}%` }} />
                </div>
                <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-4">
                  <Fact label={t("repliques.admin.films")} value={`${run.done} / ${run.total}`} />
                  <Fact label={t("repliques.admin.eta")} value={data.etaMs !== null ? fmtEta(Math.round(data.etaMs / 1000)) : "—"} />
                  <Fact label={t("repliques.admin.read")} value={fmtSize(run.bytesRead)} />
                  <Fact label={t("repliques.admin.errors")} value={String(run.errors)} />
                </dl>
                {(data.currentFilms.length > 0 || run.lastFilm) && (
                  <p className="truncate text-xs text-subtle">
                    {data.currentFilms.length > 0 ? t("repliques.admin.current", { title: data.currentFilms.join(", ") }) : t("repliques.admin.last", { title: run.lastFilm ?? "" })}
                  </p>
                )}
              </div>
            )}
          </section>

          {/* La nuit et les langues. */}
          <section className="settings-card rounded-2xl border border-white/10 bg-white/[0.03] p-4 sm:p-5">
            <h3 className="text-base font-semibold text-white">{t("repliques.admin.nightTitle")}</h3>
            <p className="mt-1 text-sm text-muted">{t("repliques.admin.nightWhy")}</p>
            <div className="mt-3 flex gap-1.5">
              {([true, false] as const).map((on) => (
                <button key={String(on)} type="button" aria-pressed={nightly === on} onClick={() => setDraft((d) => ({ ...d, nightly: on }))} className={`chip ${nightly === on ? "chip-on" : ""}`}>
                  {t(on ? "setup.on" : "setup.off")}
                </button>
              ))}
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-2 text-sm text-muted">
              <label htmlFor="repliques-start">{t("repliques.admin.from")}</label>
              <select id="repliques-start" className="select" value={start} onChange={(e) => setDraft((d) => ({ ...d, start: Number(e.target.value) }))}>
                {HOURS.map((h) => (
                  <option key={h} value={h}>{`${h} h`}</option>
                ))}
              </select>
              <label htmlFor="repliques-end">{t("repliques.admin.to")}</label>
              <select id="repliques-end" className="select" value={end} onChange={(e) => setDraft((d) => ({ ...d, end: Number(e.target.value) }))}>
                {HOURS.map((h) => (
                  <option key={h} value={h}>{`${h} h`}</option>
                ))}
              </select>
            </div>
            {data.lastNight && <p className="mt-2 text-xs text-subtle">{t("repliques.admin.lastNight", { date: data.lastNight })}</p>}
            {!data.initialDone && <p className="mt-2 text-xs text-subtle">{t("repliques.admin.nightAfterInitial")}</p>}

            <h4 className="mt-5 text-sm font-semibold text-white">{t("repliques.admin.languages")}</h4>
            <p className="mt-1 text-xs text-subtle">{t("repliques.admin.languagesWhy")}</p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {LANGUAGE_CHOICES.map((code) => (
                <button key={code} type="button" aria-pressed={languages.includes(code)} onClick={() => toggleLanguage(code)} className={`chip ${languages.includes(code) ? "chip-on" : ""}`}>
                  {code === "original" ? t("repliques.admin.original") : code.toUpperCase()}
                </button>
              ))}
            </div>
            <div className="mt-4 flex justify-end">
              <button type="button" className="btn btn-primary rounded-full" disabled={!dirty || busy !== null} onClick={() => void saveSchedule()}>
                {busy === "schedule" ? <Loader2 size={15} className="animate-spin" /> : null}
                {t("setup.save")}
              </button>
            </div>
          </section>

          {/* L'index. */}
          <section className="settings-card rounded-2xl border border-white/10 bg-white/[0.03] p-4 sm:p-5">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h3 className="text-base font-semibold text-white">{t("repliques.admin.indexTitle")}</h3>
                <p className="mt-1 text-sm text-muted">
                  {t("repliques.admin.indexSize", { size: fmtSize(data.index.bytes), lines: data.index.lines.toLocaleString(), films: data.index.filmsWithLines })}
                </p>
              </div>
              <button type="button" className="btn btn-sm rounded-full" disabled={busy !== null || !mountOk} onClick={() => void act("rebuild")}>
                <RotateCcw size={14} />
                {t("repliques.admin.rebuild")}
              </button>
            </div>
            <p className="mt-2 text-xs text-subtle">
              {t(`repliques.admin.parallel.${data.parallel.reason}`, { n: data.parallel.queues })}
              {data.write.slices > 0 ? ` · ${t("repliques.admin.writeSlice", { ms: data.write.maxSliceMs })}` : ""}
            </p>
            {data.errors.length > 0 && (
              <details className="mt-3">
                <summary className="cursor-pointer text-sm text-warning">{t("repliques.admin.errorList", { n: data.index.errors })}</summary>
                <ul className="mt-2 divide-y divide-white/5">
                  {data.errors.map((e) => (
                    <li key={e.itemId} className="py-1.5 text-xs">
                      <span className="text-white">{e.title}</span>
                      <span className="text-subtle"> — {e.error}</span>
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </section>
        </>
      )}
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-subtle">{label}</dt>
      <dd className="tabular-nums text-white">{value}</dd>
    </div>
  );
}
