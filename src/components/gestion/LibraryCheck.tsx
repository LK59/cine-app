"use client";

import { useState } from "react";
import useSWR from "swr";
import { AlertTriangle, ChevronDown, Film, Loader2, Play, ScanSearch, Scale, Tv, Wrench } from "lucide-react";
import { fetcher } from "@/lib/swr";
import { useT, useLocale } from "@/components/TranslationProvider";
import { getDateLocale } from "@/lib/i18n";
import { useToast } from "@/components/Toast";
import { PageHeader } from "@/components/PageHeader";
import { ErrorState, LoadingState } from "@/components/StateViews";
import { Panel } from "@/components/activity/parts";
import { IntegrityPanel } from "@/components/gestion/IntegrityPanel";
import {
  CHECK_CATEGORIES,
  type CheckCategory,
  type CheckFinding,
  type ExternalIds,
  type LibraryCheckStatus,
  type SeriesArbiter,
  type TmdbFacts,
} from "@/lib/libraryCheck/types";

/**
 * Infrastructure → Contrôle de la bibliothèque (DECISIONS.md §90).
 *
 * Une page qui lit et qui conseille : pour chaque désaccord, ce que dit chaque source, qui a
 * probablement raison, et le geste à faire chez le service — écrit, jamais fait d'ici. La seule
 * écriture est l'exception par série de §89, « faire confiance à Jellyfin pour les noms d'épisodes »,
 * qui ne vit que dans CineApp et se retire d'un geste ; l'arbitrage peut la *conseiller*, il ne la pose
 * jamais seul.
 */

export const LIBRARY_CHECK_KEY = "/api/admin/library-check";
const PAGE = 12;

type TFn = (key: string, vars?: Record<string, string | number>) => string;

const serviceOf = (f: CheckFinding) => (f.kind === "movie" ? "Radarr" : "Sonarr");

function idsText(ids: Partial<ExternalIds>, t: TFn): string {
  const parts = [ids.tmdbId ? `TMDB ${ids.tmdbId}` : null, ids.tvdbId ? `TVDB ${ids.tvdbId}` : null, ids.imdbId ? `IMDb ${ids.imdbId}` : null].filter(Boolean);
  return parts.length ? parts.join(" · ") : t("libraryCheck.says.noIds");
}

function factsText(facts: TmdbFacts | null, t: TFn): string | null {
  if (!facts?.title) return null;
  return [facts.title, facts.year ? `(${facts.year})` : null, facts.runtime ? `· ${t("libraryCheck.minutes", { n: facts.runtime })}` : null].filter(Boolean).join(" ");
}

const VERDICT_TONE: Record<CheckFinding["verdict"], string> = {
  catalogue: "bg-white/8 text-white",
  jellyfin: "bg-warning/10 text-warning",
  file: "bg-danger/10 text-danger",
  unknown: "bg-white/5 text-muted",
  info: "bg-white/5 text-subtle",
};

function Says({ who, children }: { who: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-2 text-sm">
      <span className="w-20 shrink-0 text-xs leading-5 text-subtle">{who}</span>
      <span className="min-w-0 flex-1 break-words text-muted">{children}</span>
    </div>
  );
}

function Arbiter({ arbiter, identity, t }: { arbiter: SeriesArbiter | null | undefined; identity: boolean; t: TFn }) {
  if (!arbiter) return null;
  const facts = [
    t("libraryCheck.arbiter.score", { score: arbiter.score.toFixed(2) }),
    !identity && arbiter.jellyfinTitles !== null ? t("libraryCheck.arbiter.titlesJellyfin", { n: arbiter.jellyfinTitles.toFixed(2) }) : null,
    !identity && arbiter.sonarrTitles !== null ? t("libraryCheck.arbiter.titlesSonarr", { n: arbiter.sonarrTitles.toFixed(2) }) : null,
    identity && arbiter.sonarrTitles !== null ? t("libraryCheck.arbiter.titlesCatalogue", { n: arbiter.sonarrTitles.toFixed(2) }) : null,
    arbiter.seasonCounts
      ? identity
        ? t("libraryCheck.arbiter.seasonsIdentity", { tmdb: arbiter.seasonCounts.tmdb, other: arbiter.seasonCounts.other ?? 0, n: arbiter.seasonCounts.compared })
        : t("libraryCheck.arbiter.seasons", { tmdb: arbiter.seasonCounts.tmdb, sonarr: arbiter.seasonCounts.sonarr, n: arbiter.seasonCounts.compared })
      : null,
  ].filter(Boolean);
  return (
    <div className="rounded-xl bg-white/4 px-3 py-2.5">
      <p className="flex items-center gap-1.5 text-xs font-medium text-muted">
        <Scale size={13} /> {t("libraryCheck.arbiter.title")}
      </p>
      <p className="mt-1 text-xs text-subtle">{facts.join(" · ")}</p>
      {arbiter.examples.length > 0 ? (
        <ul className="mt-1.5 space-y-1 text-xs text-muted">
          {arbiter.examples.map((e) => (
            <li key={e.disk} className="break-words">
              <span className="font-medium text-white">{e.disk}</span> · Jellyfin « {e.jellyfin ?? "—"} » · TMDB « {e.tmdbAtDisk ?? "—"} »
              {e.sonarr.length > 0 && (
                <>
                  {" "}· Sonarr {e.sonarr.join(", ")} « {e.sonarrTitle ?? "—"} »
                </>
              )}
            </li>
          ))}
        </ul>
      ) : (
        arbiter.verdict === "unknown" && <p className="mt-1 text-xs text-subtle">{t("libraryCheck.arbiter.none")}</p>
      )}
    </div>
  );
}

function gestureOf(f: CheckFinding, t: TFn): string {
  const service = serviceOf(f);
  switch (f.category) {
    case "jellyfinOnly":
      if (!f.serviceConfigured) return t("libraryCheck.gesture.noService", { service });
      return t(f.kind === "movie" ? "libraryCheck.gesture.radarrImport" : "libraryCheck.gesture.sonarrImport", { folder: f.folder ?? f.title });
    case "identity": {
      const wanted = factsText(f.catalogueTmdb, t) ?? f.title;
      if (f.verdict === "jellyfin") {
        return f.kind === "movie"
          ? t("libraryCheck.gesture.radarrReplace", { title: f.title })
          : t("libraryCheck.gesture.sonarrFixIdentity", { title: f.title, jellyfin: f.jellyfin.name });
      }
      if (f.verdict === "unknown") return t("libraryCheck.gesture.identityUnknown", { service, tmdb: f.catalogue.tmdbId ?? "—" });
      return f.kind === "movie"
        ? t("libraryCheck.gesture.jellyfinIdentifyMovie", { tmdb: f.catalogue.tmdbId ?? "—", title: wanted })
        : t("libraryCheck.gesture.jellyfinIdentifySeries", { tvdb: f.catalogue.tvdbId ?? "—", tmdb: f.catalogue.tmdbId ?? "—", title: wanted });
    }
    case "numbering":
      return t(
        f.verdict === "jellyfin" ? "libraryCheck.gesture.numberingJellyfin" : f.verdict === "catalogue" ? "libraryCheck.gesture.numberingSonarr" : "libraryCheck.gesture.numberingUnknown",
        { title: f.title }
      );
    case "misfiled":
      return t("libraryCheck.gesture.radarrReplace", { title: f.title });
    case "hardlinks":
      return t("libraryCheck.gesture.hardlinks");
  }
}

function TrustToggle({ finding, trusted, onChange }: { finding: CheckFinding & { kind: "series" }; trusted: boolean; onChange: () => void }) {
  const t = useT();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const sonarrId = finding.category === "numbering" ? finding.sonarrId : finding.category === "identity" ? finding.catalogueId : null;
  if (sonarrId === null) return null;
  // L'arbitrage conseille, l'administrateur décide : le bouton est mis en avant, jamais actionné seul.
  const suggested = !trusted && finding.verdict === "jellyfin";
  async function toggle() {
    setBusy(true);
    const res = await fetch(`${LIBRARY_CHECK_KEY}/trust`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sonarrId, trusted: !trusted, title: finding.title }),
    }).catch(() => null);
    setBusy(false);
    if (!res?.ok) return toast.error(t("libraryCheck.trust.failed"));
    toast.success(t(trusted ? "libraryCheck.trust.removed" : "libraryCheck.trust.saved"));
    onChange();
  }
  return (
    <div className="flex flex-wrap items-center gap-2">
      <button type="button" aria-pressed={trusted} disabled={busy} onClick={() => void toggle()} className={`btn btn-sm rounded-full ${suggested ? "btn-primary" : ""}`}>
        {busy && <Loader2 size={14} className="animate-spin" />}
        {t(trusted ? "libraryCheck.trust.off" : "libraryCheck.trust.on")}
      </button>
      {suggested && <span className="text-xs text-subtle">{t("libraryCheck.trust.suggested")}</span>}
      {trusted && <span className="text-xs text-warning">{t("libraryCheck.trust.active")}</span>}
    </div>
  );
}

function FindingCard({ f, trusted, onTrustChange }: { f: CheckFinding; trusted: ReadonlySet<number>; onTrustChange: () => void }) {
  const t = useT();
  const service = serviceOf(f);
  const Icon = f.kind === "movie" ? Film : Tv;
  const sonarrId = f.category === "numbering" ? f.sonarrId : f.category === "identity" && f.kind === "series" ? f.catalogueId : null;
  const verdictLabel = t(`libraryCheck.verdict.${f.verdict}`, { service });

  return (
    <li className="space-y-2.5 px-4 py-3.5" data-testid={`finding-${f.key}`}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <p className="flex min-w-0 items-center gap-2 text-sm font-medium text-white">
          <Icon size={14} className="shrink-0 text-muted" />
          <span className="min-w-0 break-words">
            {f.title}
            {f.year ? <span className="font-normal text-subtle"> ({f.year})</span> : null}
          </span>
        </p>
        <span className={`shrink-0 rounded-full px-2.5 py-0.5 text-xs font-medium ${VERDICT_TONE[f.verdict]}`}>
          {f.category === "hardlinks" ? t("libraryCheck.hardlinks.intended") : verdictLabel}
        </span>
      </div>

      <div className="space-y-1">
        {f.category === "jellyfinOnly" && (
          <>
            <Says who={t("libraryCheck.says.jellyfin")}>{idsText(f.ids, t)}</Says>
            {f.folder && <Says who={t("libraryCheck.says.file")}>{f.folder}</Says>}
          </>
        )}
        {f.category === "identity" && (
          <>
            <Says who={t("libraryCheck.says.catalogue", { service })}>
              {f.title} · {idsText(f.catalogue, t)}
              {f.folder ? ` · ${f.folder}` : ""}
            </Says>
            <Says who={t("libraryCheck.says.jellyfin")}>
              {f.jellyfin.name}
              {f.jellyfin.year ? ` (${f.jellyfin.year})` : ""} · {idsText(f.jellyfin, t)}
            </Says>
            {(factsText(f.catalogueTmdb, t) || factsText(f.jellyfinTmdb, t)) && (
              <Says who={t("libraryCheck.says.tmdb")}>{[factsText(f.catalogueTmdb, t), factsText(f.jellyfinTmdb, t)].filter(Boolean).join(" ↔ ")}</Says>
            )}
            {f.fileMinutes !== null && <Says who={t("libraryCheck.says.file")}>{t("libraryCheck.minutes", { n: f.fileMinutes })}</Says>}
          </>
        )}
        {f.category === "numbering" && (
          <>
            <Says who={t("libraryCheck.says.catalogue", { service })}>
              {t("libraryCheck.numbering.summary", { mismatched: f.mismatched, compared: f.compared })}
              {f.seriesType ? ` · ${t("libraryCheck.numbering.seriesType", { type: f.seriesType })}` : ""}
            </Says>
            {f.unattached > 0 && <Says who={t("libraryCheck.says.file")}>{t("libraryCheck.numbering.unattached", { n: f.unattached })}</Says>}
          </>
        )}
        {f.category === "misfiled" && (
          <>
            <Says who={t("libraryCheck.says.catalogue", { service })}>
              {f.title}
              {f.year ? ` (${f.year})` : ""}
              {f.expectedMinutes ? ` · ${t("libraryCheck.minutes", { n: f.expectedMinutes })}` : ""}
            </Says>
            <Says who={t("libraryCheck.says.file")}>
              {[
                f.fileMinutes !== null ? t("libraryCheck.minutes", { n: f.fileMinutes }) : null,
                f.originalName ? t("libraryCheck.misfiled.original", { name: f.originalName }) : null,
              ]
                .filter(Boolean)
                .join(" · ")}
            </Says>
            {factsText(f.jellyfinTmdb, t) && <Says who={t("libraryCheck.says.jellyfin")}>{factsText(f.jellyfinTmdb, t)}</Says>}
            <ul className="ml-[5.5rem] list-disc space-y-0.5 pl-4 text-xs text-subtle">
              {f.signals.map((s) => (
                <li key={s}>
                  {t(`libraryCheck.misfiled.${s}`, {
                    file: f.fileMinutes ?? "—",
                    expected: f.expectedMinutes ?? "—",
                    years: f.nameYears.join(", "),
                    year: f.year ?? "—",
                    title: f.jellyfinTmdb?.title ?? "—",
                    runtime: f.jellyfinTmdb?.runtime ?? "—",
                  })}
                </li>
              ))}
            </ul>
          </>
        )}
        {f.category === "hardlinks" && (
          <Says who={t("libraryCheck.says.file")}>
            {f.folders.join(" ↔ ")} · {t("libraryCheck.hardlinks.files", { n: f.files })}
          </Says>
        )}
      </div>

      {(f.category === "numbering" || f.category === "identity") && <Arbiter arbiter={f.arbiter} identity={f.category === "identity"} t={t} />}

      <p className="flex gap-2 text-xs text-muted">
        <Wrench size={13} className="mt-0.5 shrink-0 text-subtle" />
        <span className="min-w-0 break-words">{gestureOf(f, t)}</span>
      </p>

      {sonarrId !== null && f.kind === "series" && <TrustToggle finding={f as CheckFinding & { kind: "series" }} trusted={trusted.has(sonarrId)} onChange={onTrustChange} />}
    </li>
  );
}

function CategoryPanel({ category, findings, trusted, onTrustChange }: { category: CheckCategory; findings: CheckFinding[]; trusted: ReadonlySet<number>; onTrustChange: () => void }) {
  const t = useT();
  const [shown, setShown] = useState(PAGE);
  return (
    <Panel title={t(`libraryCheck.categories.${category}.title`)} action={<span className="text-xs tabular-nums text-subtle">{findings.length}</span>}>
      <p className="border-b border-white/5 px-4 py-2.5 text-xs text-subtle">{t(`libraryCheck.categories.${category}.hint`)}</p>
      {findings.length === 0 ? (
        <p className="px-4 py-5 text-sm text-subtle">{t("libraryCheck.empty")}</p>
      ) : (
        <ul className="divide-y divide-white/5">
          {findings.slice(0, shown).map((f) => (
            <FindingCard key={f.key} f={f} trusted={trusted} onTrustChange={onTrustChange} />
          ))}
        </ul>
      )}
      {findings.length > shown && (
        <button type="button" onClick={() => setShown((n) => n + PAGE * 4)} className="flex w-full items-center justify-center gap-1 border-t border-white/5 px-4 py-2.5 text-xs text-subtle hover:text-muted">
          {t("libraryCheck.showMore", { n: findings.length - shown })} <ChevronDown size={13} />
        </button>
      )}
    </Panel>
  );
}

export function LibraryCheck() {
  const t = useT();
  const { locale } = useLocale();
  const toast = useToast();
  const { data, error, mutate } = useSWR<LibraryCheckStatus>(LIBRARY_CHECK_KEY, fetcher, {
    refreshInterval: (latest) => (latest?.running ? 2000 : 60_000),
  });
  const [starting, setStarting] = useState(false);

  async function analyse() {
    setStarting(true);
    const res = await fetch(LIBRARY_CHECK_KEY, { method: "POST" }).catch(() => null);
    setStarting(false);
    if (!res?.ok) toast.error(t("errors.loadFailed"));
    await mutate();
  }

  const result = data?.result ?? null;
  const trusted = new Set((data?.trusted ?? []).map((x) => x.sonarrId));
  const running = !!data?.running;

  return (
    <div>
      <PageHeader
        title={t("nav.libraryCheck")}
        subtitle={t("libraryCheck.subtitle")}
        action={
          <button type="button" className="btn btn-primary btn-sm rounded-full" disabled={running || starting || !data} onClick={() => void analyse()}>
            {running || starting ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
            {running ? t("libraryCheck.analysing") : t("libraryCheck.analyse")}
          </button>
        }
      />

      {!data && error && <ErrorState message={t("errors.loadFailed")} onRetry={() => void mutate()} />}
      {!data && !error && <LoadingState />}

      {data && (
        <div className="space-y-6">
          <div className="space-y-1.5 text-xs text-subtle">
            {running && data.progress && (
              <p className="flex items-center gap-1.5 text-muted">
                <Loader2 size={12} className="animate-spin" />
                {t(`libraryCheck.progress.${data.progress.step}`, { done: data.progress.done, total: data.progress.total })}
              </p>
            )}
            <p>
              {result
                ? t("libraryCheck.lastRun", {
                    when: new Date(result.computedAt).toLocaleString(getDateLocale(locale), { dateStyle: "medium", timeStyle: "short" }),
                    seconds: Math.max(1, Math.round(result.durationMs / 1000)),
                  })
                : t("libraryCheck.never")}
            </p>
            {result && (
              <p>
                {t("libraryCheck.sources.title")} :{" "}
                {(["radarr", "sonarr", "jellyfin", "tmdb"] as const)
                  .map((k) => `${k === "tmdb" ? "TMDB" : k[0].toUpperCase() + k.slice(1)} ${t(`libraryCheck.sources.${result.sources[k]}`)}`)
                  .join(" · ")}
                {result.sources.media === "absent" ? ` · ${t("libraryCheck.sources.mediaAbsent")}` : ""}
              </p>
            )}
            {data.error && (
              <p className="flex items-center gap-1.5 text-danger">
                <AlertTriangle size={12} /> {t("libraryCheck.error", { message: data.error })}
              </p>
            )}
          </div>

          {/* L'intégrité des fichiers (§93) : une tâche de fond à part, qui relit les fichiers eux-mêmes. */}
          <IntegrityPanel />

          {data.trusted.length > 0 && (
            <Panel title={t("libraryCheck.trust.listTitle")} icon={Tv}>
              <p className="border-b border-white/5 px-4 py-2.5 text-xs text-subtle">{t("libraryCheck.trust.listHint")}</p>
              <ul className="divide-y divide-white/5">
                {data.trusted.map((x) => (
                  <li key={x.sonarrId} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 text-sm text-white">
                    <span>{x.title ?? `Sonarr ${x.sonarrId}`}</span>
                    <TrustToggle
                      finding={{ category: "numbering", key: `trusted:${x.sonarrId}`, kind: "series", title: x.title ?? "", year: null, folder: null, verdict: "info", sonarrId: x.sonarrId, seriesType: null, mismatched: 0, compared: 0, unattached: 0, arbiter: null, trusted: true }}
                      trusted
                      onChange={() => void mutate()}
                    />
                  </li>
                ))}
              </ul>
            </Panel>
          )}

          {result ? (
            CHECK_CATEGORIES.map((category) => (
              <CategoryPanel
                key={category}
                category={category}
                findings={result.findings.filter((f) => f.category === category)}
                trusted={trusted}
                onTrustChange={() => void mutate()}
              />
            ))
          ) : (
            !running && (
              <div className="card flex flex-col items-center gap-3 px-4 py-10 text-center text-sm text-subtle">
                <ScanSearch size={22} />
                {t("libraryCheck.never")}
              </div>
            )
          )}
        </div>
      )}
    </div>
  );
}
