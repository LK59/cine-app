"use client";

import { useMemo, useState } from "react";
import useSWR from "swr";
import { Loader2, Pause, Play, Plus, Search, X, Zap } from "lucide-react";
import { fetcher, MOVIES_CATALOGUE_KEY, SERIES_CATALOGUE_KEY } from "@/lib/swr";
import { cinemaFetcher } from "@/lib/cinemaPayload";
import { searchCinemaLibrary } from "@/lib/cinemaSearch";
import type { CinemaMoviesPayload } from "@/app/api/cinema/movies/route";
import type { CinemaSeriesPayload } from "@/app/api/cinema/series/route";
import { useLocale, useT } from "@/components/TranslationProvider";
import { useToast } from "@/components/Toast";
import { ErrorState } from "@/components/StateViews";
import type { ScanAction, ScanTierStatus, XrayScanStatus } from "@/lib/xray/scheduler";

/**
 * Configuration → Acteurs à l'écran : l'analyse de la bibliothèque en fond (DECISIONS.md §138,
 * « Le planificateur de la bibliothèque »), sur le modèle de la recherche de répliques (§88,
 * `DialogueSearchCard`) — l'état d'ensemble, puis une carte par palier avec sa progression, ses heures
 * de vidéo, son temps restant et ses gestes (« Lancer maintenant », « Mettre en pause » / « Reprendre »,
 * « Ne plus forcer »). Rafraîchie toutes les cinq secondes pendant l'analyse, sinon au calme.
 */

const ACTIVE: XrayScanStatus["phase"][] = ["planning", "running"];

type T = ReturnType<typeof useT>;

/** Une durée lisible, en jours au-delà d'un jour — l'analyse d'une bibliothèque se compte en semaines. */
export function fmtScanDuration(seconds: number | null, t: T): string {
  if (seconds === null || !Number.isFinite(seconds)) return "—";
  const s = Math.max(0, Math.round(seconds));
  const d = Math.floor(s / 86_400);
  const h = Math.floor((s % 86_400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return t("xrayScan.duration.days", { d, h });
  if (h > 0) return t("xrayScan.duration.hours", { h, m });
  return t("xrayScan.duration.minutes", { m: Math.max(m, s > 0 ? 1 : 0) });
}

/**
 * La barre d'un palier ou d'un titre : les éléments **traités** — analysés ou en échec — sur le total.
 * Un échec ne sera pas retenté avant une semaine ; compté comme reste à faire, il laissait la barre d'un
 * palier fini à 97 % pour toujours (revue du 09/11/2026). Les échecs ont leur part de la barre, à part.
 */
export function scanBar(done: number, failed: number, total: number): { done: number; failed: number } {
  if (total <= 0) return { done: 0, failed: 0 };
  const d = Math.min(100, (done / total) * 100);
  const f = Math.min(100 - d, (failed / total) * 100);
  return { done: Math.round(d * 10) / 10, failed: Math.round(f * 10) / 10 };
}

/** Tout est-il en pause — les trois paliers **et** la liste de priorité (palier 0) ? */
export const everyTierPaused = (data: Pick<XrayScanStatus, "tiers" | "priority">): boolean => data.tiers.every((tier) => tier.paused) && data.priority.paused;

function ScanBar({ done, failed, total, thin }: { done: number; failed: number; total: number; thin?: boolean }) {
  const bar = scanBar(done, failed, total);
  // Un palier vide est fini ; un titre de la liste sans élément connu n'a pas commencé.
  const shown = total > 0 ? bar : thin ? { done: 0, failed: 0 } : { done: 100, failed: 0 };
  const now = Math.round(shown.done + shown.failed);
  return (
    <div className={`flex ${thin ? "h-1.5" : "h-2"} overflow-hidden rounded-full bg-white/10`} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={now}>
      <div className="h-full bg-white transition-[width] duration-500" style={{ width: `${shown.done}%` }} />
      {shown.failed > 0 && <div className="h-full bg-warning transition-[width] duration-500" data-testid="xray-scan-bar-failed" style={{ width: `${shown.failed}%` }} />}
    </div>
  );
}

const fmtHours = (h: number) => (h >= 100 ? Math.round(h).toLocaleString() : (Math.round(h * 10) / 10).toLocaleString());

export function XrayScanCard() {
  const t = useT();
  const toast = useToast();
  const { data, error, mutate } = useSWR<XrayScanStatus>("/api/admin/xray/scan", fetcher, {
    refreshInterval: (latest) => (latest && ACTIVE.includes(latest.phase) ? 5000 : 20_000),
  });
  const [busy, setBusy] = useState<string | null>(null);

  if (!data && error) return <ErrorState message={t("common.error")} onRetry={() => void mutate()} />;
  if (!data) return <Loader2 className="animate-spin text-subtle" />;

  if (!data.configured) {
    return (
      <section className="settings-card rounded-2xl border border-white/10 bg-white/[0.03] p-4 sm:p-5">
        <h3 className="text-base font-semibold text-white">{t("xrayScan.title")}</h3>
        <p className="mt-1 text-sm text-muted">{t("xrayScan.off")}</p>
      </section>
    );
  }

  async function post(key: string, payload: Record<string, unknown>): Promise<Response | null> {
    setBusy(key);
    const res = await fetch("/api/admin/xray/scan", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) }).catch(() => null);
    setBusy(null);
    await mutate();
    return res;
  }

  async function act(action: ScanAction, tier: number | null) {
    const res = await post(`${action}:${tier ?? "all"}`, { action, tier });
    if (!res?.ok) toast.error(t("xrayScan.actionFailed"));
  }

  async function prioritize(itemId: string, on: boolean): Promise<boolean> {
    const res = await post(`${on ? "prioritize" : "unprioritize"}:${itemId}`, { action: on ? "prioritize" : "unprioritize", itemId });
    if (res?.ok) return true;
    const body = (await res?.json().catch(() => null)) as { error?: string } | null;
    toast.error(t(body?.error === "animation" ? "xrayScan.animationRefused" : "xrayScan.actionFailed"));
    return false;
  }

  const allPaused = everyTierPaused(data);
  const current = data.current;

  return (
    <div className="space-y-4">
      <section className="settings-card rounded-2xl border border-white/10 bg-white/[0.03] p-4 sm:p-5" data-testid="xray-scan-overview">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 className="text-base font-semibold text-white">{t("xrayScan.title")}</h3>
            <p className="mt-1 text-sm text-muted">{t(`xrayScan.phase.${data.phase}`)}</p>
          </div>
          <button type="button" className="btn btn-sm rounded-full" disabled={busy !== null} onClick={() => void act(allPaused ? "resume" : "pause", null)}>
            {allPaused ? <Play size={14} /> : <Pause size={14} />}
            {t(allPaused ? "xrayScan.resumeAll" : "xrayScan.pauseAll")}
          </button>
        </div>
        <div className="mt-3 space-y-1 text-xs text-subtle">
          {current && (
            <p className="truncate text-white">
              {current.finishing && current.title
                ? t("xrayScan.currentFinishing", { title: current.title })
                : current.title
                ? t("xrayScan.current", { title: current.title, percent: Math.round(current.progress * 100) })
                : t("xrayScan.currentOther", { percent: Math.round(current.progress * 100) })}
            </p>
          )}
          <p>{data.speed !== null ? t("xrayScan.speed", { x: data.speed.toLocaleString() }) : t("xrayScan.speedUnknown")}</p>
          <p>{t("xrayScan.etaAll", { eta: fmtScanDuration(data.etaAllS, t) })}</p>
          {data.plannedAt && <p>{t("xrayScan.plannedAt", { date: new Date(data.plannedAt).toLocaleString() })}</p>}
          {data.lastError && <p className="text-warning">{t("xrayScan.lastError", { error: data.lastError })}</p>}
        </div>
      </section>

      <PriorityCard data={data} busy={busy} t={t} onPrioritize={prioritize} onTier={(action) => void act(action, 0)} />

      {data.tiers.map((tier) => (
        <TierCard key={tier.tier} tier={tier} busy={busy} onAct={(action) => void act(action, tier.tier)} t={t} />
      ))}

      <p className="px-1 text-xs text-subtle">
        {t("xrayScan.excludedWhy")} {t("xrayScan.etaNote")}
      </p>

      {data.errors.length > 0 && (
        <section className="settings-card rounded-2xl border border-white/10 bg-white/[0.03] p-4 sm:p-5">
          <details>
            <summary className="cursor-pointer text-sm text-warning">{t("xrayScan.errors")}</summary>
            <ul className="mt-2 divide-y divide-white/5">
              {data.errors.map((e) => (
                <li key={e.itemId} className="py-1.5 text-xs">
                  <span className="text-white">{e.title}</span>
                  <span className="text-subtle"> — {e.error}</span>
                </li>
              ))}
            </ul>
          </details>
        </section>
      )}
    </div>
  );
}

function TierCard({ tier, busy, onAct, t }: { tier: ScanTierStatus; busy: string | null; onAct: (action: ScanAction) => void; t: T }) {
  const mine = (action: ScanAction) => busy === `${action}:${tier.tier}`;
  return (
    <section className="settings-card rounded-2xl border border-white/10 bg-white/[0.03] p-4 sm:p-5" data-testid={`xray-scan-tier-${tier.tier}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-base font-semibold text-white">{t(`xrayScan.tier.${tier.tier}`)}</h3>
          <p className="mt-1 text-sm text-muted">{t(`xrayScan.tierWhy.${tier.tier}`)}</p>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {tier.forced ? (
            <button type="button" aria-pressed className="btn btn-primary btn-sm rounded-full" disabled={busy !== null} onClick={() => onAct("unforce")}>
              {mine("unforce") ? <Loader2 size={14} className="animate-spin" /> : <Zap size={14} />}
              {t("xrayScan.unforce")}
            </button>
          ) : (
            <button type="button" className="btn btn-primary btn-sm rounded-full" disabled={busy !== null} onClick={() => onAct("run")}>
              {mine("run") ? <Loader2 size={14} className="animate-spin" /> : <Zap size={14} />}
              {t("xrayScan.runNow")}
            </button>
          )}
          {tier.paused ? (
            <button type="button" className="btn btn-sm rounded-full" disabled={busy !== null} onClick={() => onAct("resume")}>
              {mine("resume") ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
              {t("xrayScan.resume")}
            </button>
          ) : (
            <button type="button" className="btn btn-sm rounded-full" disabled={busy !== null} onClick={() => onAct("pause")}>
              {mine("pause") ? <Loader2 size={14} className="animate-spin" /> : <Pause size={14} />}
              {t("xrayScan.pause")}
            </button>
          )}
        </div>
      </div>
      {(tier.forced || tier.paused) && <p className={`mt-2 text-xs ${tier.forced ? "text-warning" : "text-subtle"}`}>{t(tier.forced ? "xrayScan.forced" : "xrayScan.paused")}</p>}
      <div className="mt-4 space-y-2">
        <ScanBar done={tier.done} failed={tier.failed} total={tier.total} />
        <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-4">
          <Fact label={t("xrayScan.done")} value={`${tier.done.toLocaleString()} / ${tier.total.toLocaleString()}`} />
          <Fact label={t("xrayScan.hours")} value={t("xrayScan.hoursValue", { done: fmtHours(tier.hoursDone), total: fmtHours(tier.hoursTotal) })} />
          <Fact label={t("xrayScan.eta")} value={fmtScanDuration(tier.etaS, t)} />
          <Fact label={t("xrayScan.queued")} value={String(tier.queued)} />
          <Fact label={t("xrayScan.failed")} value={String(tier.failed)} />
          <Fact label={t("xrayScan.excluded")} value={String(tier.excluded)} />
        </dl>
      </div>
    </section>
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

/** Les deux catalogues du cinéma, lus d'un coup pour la recherche de la liste de priorité. */
async function fetchCatalogues(): Promise<{ movies: CinemaMoviesPayload; series: CinemaSeriesPayload }> {
  const [movies, series] = await Promise.all([cinemaFetcher<CinemaMoviesPayload>(MOVIES_CATALOGUE_KEY), cinemaFetcher<CinemaSeriesPayload>(SERIES_CATALOGUE_KEY)]);
  return { movies, series };
}

/**
 * La liste de priorité (palier 0) : un champ qui cherche dans le catalogue du cinéma (la même recherche,
 * `searchCinemaLibrary`, sur les deux catalogues qu'il lit déjà), et chaque titre ajouté avec son
 * avancement — éléments faits sur total, temps restant — et un bouton pour le retirer.
 */
function PriorityCard({
  data,
  busy,
  t,
  onPrioritize,
  onTier,
}: {
  data: XrayScanStatus;
  busy: string | null;
  t: T;
  onPrioritize: (itemId: string, on: boolean) => Promise<boolean>;
  onTier: (action: ScanAction) => void;
}) {
  const { locale } = useLocale();
  const [query, setQuery] = useState("");
  // Les catalogues ne sont lus qu'une fois le champ utilisé : la page n'en a pas besoin pour s'afficher.
  // Sous une clé à elle, pas celles du cinéma : la gestion n'a pas le catalogue en cache, et lire les
  // clés du cinéma sans `cacheOnlyOptions` est réservé aux deux écrans qui le tiennent à jour
  // (`catalogue-lu-dans-le-cache.test.tsx`) — avec, rien ne serait jamais demandé ici.
  const searching = query.trim().length >= 2;
  const { data: catalogues } = useSWR(searching ? "xray-priority-catalogues" : null, fetchCatalogues);
  const movies = catalogues?.movies;
  const series = catalogues?.series;
  const listed = new Set(data.priority.items.map((i) => i.id));
  const results = useMemo(
    () => (searching ? searchCinemaLibrary(query, movies?.items ?? [], series?.items ?? [], locale).slice(0, 8) : []),
    [searching, query, movies, series, locale],
  );
  const paused = data.priority.paused;

  return (
    <section className="settings-card rounded-2xl border border-white/10 bg-white/[0.03] p-4 sm:p-5" data-testid="xray-scan-priority">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-base font-semibold text-white">{t("xrayScan.tier.0")}</h3>
          <p className="mt-1 text-sm text-muted">{t("xrayScan.tierWhy.0")}</p>
        </div>
        {data.priority.items.length > 0 && (
          <button type="button" className="btn btn-sm rounded-full" disabled={busy !== null} onClick={() => onTier(paused ? "resume" : "pause")}>
            {paused ? <Play size={14} /> : <Pause size={14} />}
            {t(paused ? "xrayScan.resume" : "xrayScan.pause")}
          </button>
        )}
      </div>
      {paused && <p className="mt-2 text-xs text-subtle">{t("xrayScan.paused")}</p>}

      <label className="mt-4 flex items-center gap-2 rounded-xl border border-white/10 bg-white/[0.04] px-3 py-2 text-sm">
        <Search size={15} className="shrink-0 text-subtle" />
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("xrayScan.searchPlaceholder")}
          aria-label={t("xrayScan.searchPlaceholder")}
          className="min-w-0 flex-1 bg-transparent text-white placeholder:text-subtle focus:outline-none"
        />
      </label>
      {searching && (
        <ul className="mt-2 divide-y divide-white/5" data-testid="xray-priority-results">
          {results.length === 0 && <li className="py-2 text-xs text-subtle">{t("xrayScan.noResult")}</li>}
          {results.map((r) => {
            const id = r.item.jellyfinItemId?.toLowerCase();
            if (!id) return null;
            const added = listed.has(id);
            return (
              <li key={`${r.kind}:${id}`} className="flex items-center justify-between gap-3 py-1.5 text-sm">
                <span className="min-w-0 truncate text-white">
                  {r.item.title}
                  {r.item.year ? <span className="text-subtle"> ({r.item.year})</span> : null}
                  <span className="text-subtle"> · {t(r.kind === "movie" ? "xrayScan.kindMovie" : "xrayScan.kindSeries")}</span>
                </span>
                <button
                  type="button"
                  className="btn btn-sm shrink-0 rounded-full"
                  disabled={added || busy !== null}
                  onClick={() => void onPrioritize(id, true).then((ok) => ok && setQuery(""))}
                >
                  {busy === `prioritize:${id}` ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
                  {t(added ? "xrayScan.added" : "xrayScan.add")}
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {data.priority.items.length === 0 ? (
        <p className="mt-3 text-xs text-subtle">{t("xrayScan.priorityEmpty")}</p>
      ) : (
        <ul className="mt-3 space-y-3">
          {data.priority.items.map((item) => {
            return (
              <li key={item.id} data-testid="xray-priority-item">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm text-white">{item.title}</p>
                    <p className="text-xs text-subtle">
                      {t(item.kind === "Series" ? "xrayScan.priorityEpisodes" : "xrayScan.priorityMovie", { done: item.done, total: item.total })}
                      {" · "}
                      {t("xrayScan.eta")} {fmtScanDuration(item.etaS, t)}
                      {item.failed > 0 ? ` · ${t("xrayScan.failed")} ${item.failed}` : ""}
                    </p>
                  </div>
                  <button
                    type="button"
                    aria-label={t("xrayScan.remove")}
                    title={t("xrayScan.remove")}
                    className="btn btn-sm shrink-0 rounded-full"
                    disabled={busy !== null}
                    onClick={() => void onPrioritize(item.id, false)}
                  >
                    {busy === `unprioritize:${item.id}` ? <Loader2 size={14} className="animate-spin" /> : <X size={14} />}
                  </button>
                </div>
                <div className="mt-1.5">
                  <ScanBar done={item.done} failed={item.failed} total={item.total} thin />
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
