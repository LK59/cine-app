"use client";

import { useMemo, useState } from "react";
import useSWR from "swr";
import {
  AlertTriangle,
  ChevronDown,
  Film,
  HardDrive,
  ListFilter,
  Loader2,
  RefreshCw,
  Search,
  Trash2,
  Tv,
  Users,
  History,
  CheckCircle2,
  XCircle,
} from "lucide-react";
import { fetcher } from "@/lib/swr";
import { fmtSize } from "@/lib/format";
import { apiAction } from "@/lib/apiAction";
import { useT, useLocale } from "@/components/TranslationProvider";
import { PageHeader } from "@/components/PageHeader";
import { ErrorState, LoadingState } from "@/components/StateViews";
import type { TriAccount, TriFlag, TriPayload, TriPlan, TriRemoval, TriTitle } from "@/lib/tri/types";

/**
 * Infrastructure → Tri de la bibliothèque (DECISIONS.md §198).
 *
 * Trois onglets : les titres à examiner (du plus suspect au moins suspect, filtrables, chacun s'ouvrant
 * sur sa fiche — demandes, lectures, séances, raisons du score), les comptes et leurs scores, et le
 * journal de ce qui a été supprimé. La suppression passe toujours par un aperçu calculé à la demande
 * — fichiers, torrents (cross-seeds compris), espace rendu — puis par une confirmation explicite ; le
 * serveur refuse si le titre a changé entre les deux.
 */

export const TRI_KEY = "/api/admin/tri";
const PAGE = 50;

type TFn = (key: string, vars?: Record<string, string | number>) => string;
type Tab = "titles" | "accounts" | "removed";
type Sort = "score" | "size" | "requested" | "rating" | "added";
type FlagFilter = TriFlag | "farFromProfile" | "neverOpened";

const FLAG_FILTERS: FlagFilter[] = ["neverOpened", "documentary", "animationMovie", "animationSeries", "tvMovie", "lowRating", "farFromProfile"];

/** Les tailles dans la langue de l'écran (« 56,5 Go »), comme le reste de la gestion. */
function useSize(): (bytes: number) => string {
  const { locale } = useLocale();
  return (bytes: number) => fmtSize(bytes, locale);
}

function useDates() {
  const { locale } = useLocale();
  return useMemo(() => {
    const day = new Intl.DateTimeFormat(locale, { day: "numeric", month: "short", year: "numeric" });
    const dayTime = new Intl.DateTimeFormat(locale, { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
    const rel = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
    const ago = (iso: string | null) => {
      if (!iso) return "—";
      const days = Math.round((Date.parse(iso) - Date.now()) / 86_400_000);
      if (Math.abs(days) < 31) return rel.format(days, "day");
      if (Math.abs(days) < 365) return rel.format(Math.round(days / 30), "month");
      return rel.format(Math.round((days / 365) * 10) / 10, "year");
    };
    return {
      day: (iso: string | null) => (iso ? day.format(new Date(iso)) : "—"),
      dayTime: (iso: string | null) => (iso ? dayTime.format(new Date(iso)) : "—"),
      ago,
    };
  }, [locale]);
}

const firstRequest = (t: TriTitle) => t.requests.reduce<string | null>((a, r) => (a === null || r.at < a ? r.at : a), null);
const isNeverOpened = (t: TriTitle) => t.viewers.length === 0 && t.sessions.length === 0;

function scoreTone(score: number): string {
  if (score >= 60) return "bg-danger/15 text-danger";
  if (score >= 40) return "bg-warning/15 text-warning";
  return "bg-white/8 text-muted";
}

function accountTone(score: number): string {
  if (score >= 70) return "bg-success/15 text-success";
  if (score >= 45) return "bg-warning/15 text-warning";
  return "bg-danger/15 text-danger";
}

function Chip({ children, tone = "bg-white/6 text-muted" }: { children: React.ReactNode; tone?: string }) {
  return <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ${tone}`}>{children}</span>;
}

function Poster({ src, kind }: { src: string | null; kind: TriTitle["kind"] }) {
  return (
    <div className="flex h-14 w-10 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-white/6">
      {src ? (
        // eslint-disable-next-line @next/next/no-img-element -- vignette de Radarr/Sonarr (TMDB ou TVDB), comme les pages Radarr et Sonarr
        <img src={src} alt="" loading="lazy" className="h-full w-full object-cover" />
      ) : kind === "movie" ? (
        <Film size={16} className="text-subtle" />
      ) : (
        <Tv size={16} className="text-subtle" />
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <p className="text-xs font-semibold uppercase tracking-wide text-subtle">{title}</p>
      {children}
    </div>
  );
}

/* ─── Suppression : aperçu puis confirmation ─────────────────────────────────────────────── */

type RemovalState =
  | { step: "idle" }
  | { step: "planning" }
  | { step: "plan"; plan: TriPlan & { skipped?: { hash: string; name: string; reason: string }[] } }
  | { step: "removing"; plan: TriPlan }
  | { step: "done"; result: TriRemoval }
  | { step: "error"; message: string };

function RemovalBox({ title, t, onRemoved }: { title: TriTitle; t: TFn; onRemoved: () => void }) {
  const size = useSize();
  const [state, setState] = useState<RemovalState>({ step: "idle" });
  const [showFiles, setShowFiles] = useState(false);

  const preview = async () => {
    setState({ step: "planning" });
    try {
      const plan = (await apiAction(`${TRI_KEY}/plan`, { method: "POST", body: JSON.stringify({ kind: title.kind, id: title.id }) })) as TriPlan;
      setState({ step: "plan", plan });
    } catch (e) {
      setState({ step: "error", message: e instanceof Error ? e.message : String(e) });
    }
  };
  const confirm = async (plan: TriPlan) => {
    setState({ step: "removing", plan });
    try {
      const result = (await apiAction(`${TRI_KEY}/remove`, {
        method: "POST",
        body: JSON.stringify({ kind: title.kind, id: title.id, fingerprint: plan.fingerprint }),
      })) as TriRemoval;
      setState({ step: "done", result });
      onRemoved();
    } catch (e) {
      setState({ step: "error", message: e instanceof Error ? e.message : String(e) });
    }
  };

  if (state.step === "idle")
    return (
      <button type="button" className="btn btn-sm btn-danger" onClick={preview}>
        <Trash2 size={14} /> {t("tri.remove.prepare")}
      </button>
    );
  if (state.step === "planning")
    return (
      <p className="flex items-center gap-2 text-sm text-muted">
        <Loader2 size={14} className="animate-spin" /> {t("tri.remove.planning")}
      </p>
    );
  if (state.step === "error")
    return (
      <div className="space-y-2">
        <p className="flex items-center gap-2 text-sm text-danger">
          <AlertTriangle size={14} /> {state.message}
        </p>
        <button type="button" className="btn btn-sm btn-ghost" onClick={preview}>
          {t("tri.remove.retry")}
        </button>
      </div>
    );
  if (state.step === "done") {
    const r = state.result;
    return (
      <div className="space-y-2 rounded-xl bg-success/8 p-3" data-testid="tri-removed">
        <p className="text-sm font-medium text-success">
          {t("tri.remove.done", { title: r.title, freed: r.freedBytes === null ? "?" : size(r.freedBytes) })}
        </p>
        <ul className="space-y-0.5 text-xs">
          {r.steps.map((s) => (
            <li key={s.step} className={`flex items-center gap-1.5 ${s.ok ? "text-muted" : "text-danger"}`}>
              {s.ok ? <CheckCircle2 size={12} /> : <XCircle size={12} />} {s.step}
              {s.detail ? <span className="text-subtle"> · {s.detail}</span> : null}
            </li>
          ))}
        </ul>
      </div>
    );
  }

  const plan = state.plan;
  const busy = state.step === "removing";
  const skipped = "skipped" in plan ? (plan.skipped ?? []) : [];
  return (
    <div className="space-y-3 rounded-xl border border-danger/30 bg-danger/5 p-3" data-testid="tri-plan">
      <p className="text-sm font-medium text-white">{t("tri.remove.planTitle", { title: plan.title })}</p>
      <div className="grid gap-2 text-sm sm:grid-cols-3">
        <div className="rounded-lg bg-white/4 px-3 py-2">
          <p className="text-xs text-subtle">{t("tri.remove.freed")}</p>
          <p className="text-lg font-semibold text-white">{size(plan.freedBytesEstimate)}</p>
        </div>
        <div className="rounded-lg bg-white/4 px-3 py-2">
          <p className="text-xs text-subtle">{t("tri.remove.files")}</p>
          <p className="text-lg font-semibold text-white">{plan.libraryFiles.length}</p>
        </div>
        <div className="rounded-lg bg-white/4 px-3 py-2">
          <p className="text-xs text-subtle">{t("tri.remove.torrents")}</p>
          <p className="text-lg font-semibold text-white">{plan.torrents.length}</p>
        </div>
      </div>

      <ol className="list-decimal space-y-0.5 pl-5 text-xs text-muted">
        {plan.torrents.length > 0 && <li>{t("tri.remove.step.qbit", { n: plan.torrents.length })}</li>}
        <li>{t(title.kind === "movie" ? "tri.remove.step.radarr" : "tri.remove.step.sonarr")}</li>
        {plan.jellyseerrMediaId !== null && <li>{t("tri.remove.step.jellyseerr")}</li>}
        <li>{t("tri.remove.step.jellyfin")}</li>
      </ol>

      {plan.torrents.length > 0 && (
        <ul className="max-h-48 space-y-1 overflow-y-auto text-xs">
          {plan.torrents.map((tor) => (
            <li key={tor.hash} className="flex flex-wrap items-center gap-x-2 gap-y-0.5 rounded-lg bg-white/4 px-2 py-1">
              <span className="min-w-0 flex-1 break-all text-white">{tor.name}</span>
              <Chip>{tor.category || "—"}</Chip>
              <span className="text-subtle">{size(tor.sizeBytes)}</span>
              <span className="text-subtle">· {t(`tri.remove.why.${tor.why === "fichier commun" ? "shared" : tor.why === "historique" ? "history" : "same"}`)}</span>
            </li>
          ))}
        </ul>
      )}
      {skipped.length > 0 && (
        <div className="rounded-lg bg-warning/10 px-2 py-1.5 text-xs text-warning">
          <p className="font-medium">{t("tri.remove.skipped", { n: skipped.length })}</p>
          <ul className="mt-0.5 space-y-0.5">
            {skipped.map((s) => (
              <li key={s.hash} className="break-all">
                {s.name}
              </li>
            ))}
          </ul>
        </div>
      )}
      <button type="button" className="flex items-center gap-1 text-xs text-subtle hover:text-white" onClick={() => setShowFiles((v) => !v)}>
        <ChevronDown size={12} className={showFiles ? "rotate-180" : ""} /> {t("tri.remove.showFiles", { n: plan.libraryFiles.length })}
      </button>
      {showFiles && (
        <ul className="max-h-48 space-y-0.5 overflow-y-auto text-xs text-muted">
          {plan.libraryFiles.map((f) => (
            <li key={f.path} className="flex gap-2">
              <span className="min-w-0 flex-1 break-all">{f.path}</span>
              <span className="shrink-0 text-subtle">{size(f.sizeBytes)}</span>
            </li>
          ))}
        </ul>
      )}

      <div className="flex flex-wrap items-center gap-2 pt-1">
        <button type="button" className="btn btn-sm btn-danger" disabled={busy} onClick={() => confirm(plan)} data-testid="tri-confirm">
          {busy ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />} {busy ? t("tri.remove.removing") : t("tri.remove.confirm")}
        </button>
        <button type="button" className="btn btn-sm btn-ghost" disabled={busy} onClick={() => setState({ step: "idle" })}>
          {t("tri.remove.cancel")}
        </button>
        {busy && <span className="text-xs text-subtle">{t("tri.remove.wait")}</span>}
      </div>
    </div>
  );
}

/* ─── Un titre, et sa fiche ──────────────────────────────────────────────────────────────── */

function TitleDetail({ title, t, onRemoved }: { title: TriTitle; t: TFn; onRemoved: () => void }) {
  const size = useSize();
  const d = useDates();
  const [allSessions, setAllSessions] = useState(false);
  const sessions = allSessions ? title.sessions : title.sessions.slice(0, 12);
  return (
    <div className="grid gap-5 border-t border-white/6 px-4 py-4 lg:grid-cols-2" data-testid={`tri-detail-${title.kind}-${title.id}`}>
      <div className="space-y-4">
        <Section title={t("tri.detail.facts")}>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
            <dt className="text-subtle">{t("tri.detail.size")}</dt>
            <dd className="text-white">{size(title.sizeBytes)}</dd>
            {title.episodes && (
              <>
                <dt className="text-subtle">{t("tri.detail.episodes")}</dt>
                <dd className="text-white">{t("tri.detail.episodesValue", { files: title.episodes.files, total: title.episodes.total })}</dd>
              </>
            )}
            <dt className="text-subtle">{t("tri.detail.added")}</dt>
            <dd className="text-white">
              {d.day(title.added)} <span className="text-subtle">· {d.ago(title.added)}</span>
            </dd>
            <dt className="text-subtle">{t("tri.detail.rating")}</dt>
            <dd className="text-white">{title.rating !== null ? `${title.rating.toFixed(1)} / 10 · ${title.ratingSource === "imdb" ? "IMDb" : "TVDB"}` : "—"}</dd>
            <dt className="text-subtle">{t("tri.detail.genres")}</dt>
            <dd className="text-white">{title.genres.join(", ") || "—"}</dd>
            {title.genreDistance !== null && (
              <>
                <dt className="text-subtle">{t("tri.detail.distance")}</dt>
                <dd className="text-white">{Math.round(title.genreDistance * 100)} %</dd>
              </>
            )}
          </dl>
        </Section>

        <Section title={t("tri.detail.why", { score: title.score })}>
          <ul className="space-y-1 text-sm">
            {title.reasons.map((r) => (
              <li key={r.key} className="flex items-center gap-2">
                <span className="w-8 shrink-0 text-right font-mono text-xs text-warning">+{r.points}</span>
                <span className="text-muted">{t(`tri.reason.${r.key}`)}</span>
              </li>
            ))}
          </ul>
        </Section>

        <Section title={t("tri.detail.requests", { n: title.requests.length })}>
          {title.requests.length === 0 ? (
            <p className="text-sm text-subtle">{t("tri.detail.noRequest")}</p>
          ) : (
            <ul className="space-y-1 text-sm">
              {title.requests.map((r) => (
                <li key={r.jellyseerrRequestId} className="flex flex-wrap gap-x-2">
                  <span className="font-medium text-white">{r.user}</span>
                  <span className="text-muted">{r.device ?? t("tri.detail.deviceUnknown")}</span>
                  <span className="text-subtle">
                    · {d.dayTime(r.at)} ({d.ago(r.at)})
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Section>
      </div>

      <div className="space-y-4">
        <Section title={t("tri.detail.viewers", { n: title.viewers.length })}>
          {title.viewers.length === 0 ? (
            <p className="text-sm text-subtle">{t("tri.detail.noViewer")}</p>
          ) : (
            <ul className="space-y-1 text-sm">
              {title.viewers.map((v) => (
                <li key={v.user} className="flex flex-wrap gap-x-2">
                  <span className="font-medium text-white">{v.user}</span>
                  {title.kind === "series" && <span className="text-muted">{t("tri.detail.playedEpisodes", { n: v.played })}</span>}
                  <span className="text-subtle">· {v.lastPlayed ? `${d.day(v.lastPlayed)} (${d.ago(v.lastPlayed)})` : t("tri.detail.noDate")}</span>
                </li>
              ))}
            </ul>
          )}
        </Section>

        <Section title={t("tri.detail.sessions", { n: title.sessions.length })}>
          {title.sessions.length === 0 ? (
            <p className="text-sm text-subtle">{t("tri.detail.noSession")}</p>
          ) : (
            <>
              <ul className="space-y-1 text-sm">
                {sessions.map((s, i) => (
                  <li key={`${s.at}-${i}`} className="flex flex-wrap gap-x-2">
                    <span className="font-medium text-white">{s.user}</span>
                    <span className="text-muted">{s.device}</span>
                    {s.episode && <Chip>{s.episode}</Chip>}
                    <span className="text-subtle">· {d.dayTime(s.at)}</span>
                    {s.watchedMin !== null && <span className="text-subtle">· {t("tri.detail.minutes", { n: s.watchedMin })}</span>}
                  </li>
                ))}
              </ul>
              {title.sessions.length > 12 && (
                <button type="button" className="text-xs text-subtle hover:text-white" onClick={() => setAllSessions((v) => !v)}>
                  {allSessions ? t("tri.detail.less") : t("tri.detail.more", { n: title.sessions.length - 12 })}
                </button>
              )}
            </>
          )}
        </Section>

        <Section title={t("tri.detail.removeTitle")}>
          <RemovalBox title={title} t={t} onRemoved={onRemoved} />
        </Section>
      </div>
    </div>
  );
}

function TitleRow({ title, open, onToggle, t, onRemoved }: { title: TriTitle; open: boolean; onToggle: () => void; t: TFn; onRemoved: () => void }) {
  const size = useSize();
  const d = useDates();
  const req = firstRequest(title);
  const requesters = [...new Set(title.requests.map((r) => (r.device ? `${r.user} · ${r.device}` : r.user)))];
  const never = isNeverOpened(title);
  return (
    <li className={open ? "bg-white/3" : undefined}>
      <button type="button" onClick={onToggle} aria-expanded={open} className="flex w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-white/4">
        <Poster src={title.poster} kind={title.kind} />
        <div className="min-w-0 flex-1 space-y-1">
          <p className="flex min-w-0 items-center gap-1.5 text-sm font-medium text-white">
            {title.kind === "movie" ? <Film size={13} className="shrink-0 text-subtle" /> : <Tv size={13} className="shrink-0 text-subtle" />}
            <span className="truncate">{title.title}</span>
            {title.year ? <span className="shrink-0 font-normal text-subtle">({title.year})</span> : null}
          </p>
          <div className="flex flex-wrap items-center gap-1">
            {never ? <Chip tone="bg-danger/12 text-danger">{t("tri.neverOpened")}</Chip> : <Chip tone="bg-success/12 text-success">{t("tri.openedBy", { n: new Set([...title.viewers.map((v) => v.user), ...title.sessions.map((s) => s.user)]).size })}</Chip>}
            {title.flags.map((f) => (
              <Chip key={f} tone="bg-warning/10 text-warning">
                {t(`tri.flag.${f}`)}
              </Chip>
            ))}
            {title.genreDistance !== null && title.genreDistance >= 0.7 && <Chip tone="bg-warning/10 text-warning">{t("tri.flag.farFromProfile")}</Chip>}
          </div>
          <p className="truncate text-xs text-subtle">
            {requesters.length ? `${requesters.join(", ")} · ${d.ago(req)}` : t("tri.noRequester")}
          </p>
        </div>
        <div className="hidden shrink-0 text-right text-xs text-muted sm:block">
          <p className="text-sm text-white">{size(title.sizeBytes)}</p>
          <p>{title.rating !== null ? `★ ${title.rating.toFixed(1)}` : "—"}</p>
        </div>
        <span className={`w-11 shrink-0 rounded-lg py-1 text-center text-sm font-semibold ${scoreTone(title.score)}`}>{title.score}</span>
        <ChevronDown size={16} className={`shrink-0 text-subtle transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open && <TitleDetail title={title} t={t} onRemoved={onRemoved} />}
    </li>
  );
}

/* ─── Onglet titres ──────────────────────────────────────────────────────────────────────── */

function TitlesTab({ data, t, account, setAccount, onRemoved }: { data: TriPayload; t: TFn; account: string; setAccount: (a: string) => void; onRemoved: () => void }) {
  const size = useSize();
  const [kind, setKind] = useState<"all" | "movie" | "series">("all");
  const [flags, setFlags] = useState<Set<FlagFilter>>(new Set(["neverOpened"]));
  const [sort, setSort] = useState<Sort>("score");
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const [limit, setLimit] = useState(PAGE);
  const [removed, setRemoved] = useState<Set<string>>(new Set());

  const keyOf = (x: TriTitle) => `${x.kind}:${x.id}`;
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = data.titles.filter((x) => {
      if (kind !== "all" && x.kind !== kind) return false;
      if (account && !x.requests.some((r) => r.user === account)) return false;
      if (q && !x.title.toLowerCase().includes(q)) return false;
      for (const f of flags) {
        if (f === "neverOpened" ? !isNeverOpened(x) : f === "farFromProfile" ? !(x.genreDistance !== null && x.genreDistance >= 0.7) : !x.flags.includes(f)) return false;
      }
      return true;
    });
    const by: Record<Sort, (a: TriTitle, b: TriTitle) => number> = {
      score: (a, b) => b.score - a.score,
      size: (a, b) => b.sizeBytes - a.sizeBytes,
      requested: (a, b) => (firstRequest(a) ?? "9").localeCompare(firstRequest(b) ?? "9"),
      rating: (a, b) => (a.rating ?? 11) - (b.rating ?? 11),
      added: (a, b) => (a.added ?? "9").localeCompare(b.added ?? "9"),
    };
    return list.sort(by[sort]);
  }, [data.titles, kind, account, query, flags, sort]);

  const totalBytes = filtered.reduce((a, x) => a + x.sizeBytes, 0);
  const toggleFlag = (f: FlagFilter) =>
    setFlags((prev) => {
      const next = new Set(prev);
      if (next.has(f)) next.delete(f);
      else next.add(f);
      return next;
    });
  const accounts = useMemo(() => data.accounts.map((a) => a.user).sort(), [data.accounts]);

  return (
    <div className="space-y-3">
      <div className="space-y-2 rounded-2xl bg-white/3 p-3">
        <div className="flex flex-wrap items-center gap-2">
          <label className="relative min-w-[12rem] flex-1">
            <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-subtle" />
            <input
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setLimit(PAGE);
              }}
              placeholder={t("tri.filter.search")}
              className="w-full rounded-lg bg-white/6 py-1.5 pl-8 pr-2 text-sm text-white placeholder:text-subtle"
            />
          </label>
          <select value={kind} onChange={(e) => setKind(e.target.value as typeof kind)} className="rounded-lg bg-white/6 px-2 py-1.5 text-sm text-white">
            <option value="all">{t("tri.filter.allKinds")}</option>
            <option value="movie">{t("tri.filter.movies")}</option>
            <option value="series">{t("tri.filter.series")}</option>
          </select>
          <select value={account} onChange={(e) => setAccount(e.target.value)} className="rounded-lg bg-white/6 px-2 py-1.5 text-sm text-white">
            <option value="">{t("tri.filter.allAccounts")}</option>
            {accounts.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
          <select value={sort} onChange={(e) => setSort(e.target.value as Sort)} className="rounded-lg bg-white/6 px-2 py-1.5 text-sm text-white">
            {(["score", "size", "requested", "rating", "added"] as Sort[]).map((s) => (
              <option key={s} value={s}>
                {t(`tri.sort.${s}`)}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <ListFilter size={14} className="text-subtle" />
          {FLAG_FILTERS.map((f) => (
            <button key={f} type="button" onClick={() => toggleFlag(f)} className={`btn btn-sm ${flags.has(f) ? "btn-on" : "btn-ghost"}`} aria-pressed={flags.has(f)}>
              {t(f === "neverOpened" ? "tri.neverOpened" : `tri.flag.${f}`)}
            </button>
          ))}
        </div>
        <p className="text-xs text-subtle">{t("tri.filter.count", { n: filtered.length, size: size(totalBytes) })}</p>
      </div>

      <ul className="divide-y divide-white/5 overflow-hidden rounded-2xl bg-white/2">
        {filtered.slice(0, limit).map((x) => {
          const k = keyOf(x);
          if (removed.has(k) && open !== k) return null;
          return (
            <TitleRow
              key={k}
              title={x}
              t={t}
              open={open === k}
              onToggle={() => {
                // Une fiche supprimée reste ouverte sur son bilan ; la refermer relit les chiffres de la page.
                if (open === k && removed.has(k)) onRemoved();
                setOpen(open === k ? null : k);
              }}
              onRemoved={() => setRemoved((prev) => new Set(prev).add(k))}
            />
          );
        })}
        {filtered.length === 0 && <li className="px-4 py-6 text-center text-sm text-subtle">{t("tri.filter.empty")}</li>}
      </ul>
      {filtered.length > limit && (
        <button type="button" className="btn btn-sm btn-ghost w-full" onClick={() => setLimit((l) => l + PAGE)}>
          {t("tri.filter.more", { n: filtered.length - limit })}
        </button>
      )}
    </div>
  );
}

/* ─── Onglet comptes ─────────────────────────────────────────────────────────────────────── */

function AccountRow({ a, data, t, onShow }: { a: TriAccount; data: TriPayload; t: TFn; onShow: () => void }) {
  const size = useSize();
  const [open, setOpen] = useState(false);
  const profiles = data.profiles.filter((p) => p.user === a.user);
  const pct = a.available ? Math.round((a.opened / a.available) * 100) : null;
  return (
    <li>
      <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-white/4">
        <span className={`w-11 shrink-0 rounded-lg py-1 text-center text-sm font-semibold ${accountTone(a.score)}`}>{a.score}</span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-white">{a.user}</p>
          <p className="text-xs text-subtle">
            {t("tri.account.summary", { requests: a.requests, opened: a.opened, available: a.available, pct: pct ?? "—" })}
            {a.avgRating !== null ? ` · ★ ${a.avgRating.toFixed(1)}` : ""}
          </p>
        </div>
        <div className="hidden shrink-0 text-right text-xs sm:block">
          <p className="text-white">{size(a.neverOpenedBytes)}</p>
          <p className="text-subtle">{t("tri.account.neverOpenedSize")}</p>
        </div>
        <ChevronDown size={16} className={`shrink-0 text-subtle transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open && (
        <div className="grid gap-5 border-t border-white/6 px-4 py-4 lg:grid-cols-2">
          <Section title={t("tri.account.parts")}>
            <ul className="space-y-1.5">
              {a.parts.map((p) => (
                <li key={p.key} className="space-y-0.5">
                  <div className="flex justify-between text-xs">
                    <span className="text-muted">{t(`tri.part.${p.key}`)}</span>
                    <span className="font-mono text-subtle">
                      {p.points} / {p.max}
                    </span>
                  </div>
                  <div className="h-1.5 overflow-hidden rounded-full bg-white/6">
                    <div className="h-full rounded-full bg-white/50" style={{ width: `${(p.points / p.max) * 100}%` }} />
                  </div>
                </li>
              ))}
            </ul>
            <p className="pt-1 text-xs text-subtle">
              {t("tri.account.facts", { last90: a.last90Days, burst: Math.round(a.burstShare * 100), devices: a.profiles.length })}
            </p>
          </Section>
          <div className="space-y-4">
            <Section title={t("tri.account.profiles", { n: profiles.length })}>
              {profiles.length === 0 ? (
                <p className="text-sm text-subtle">{t("tri.account.noProfile")}</p>
              ) : (
                <ul className="space-y-1.5 text-sm">
                  {profiles.map((p) => (
                    <li key={p.key}>
                      <span className="font-medium text-white">{p.device}</span>
                      <span className="text-subtle"> · {t("tri.account.openedTitles", { n: p.opened })}</span>
                      <p className="text-xs text-muted">{p.topGenres.map((g) => `${g.genre} ${g.count}`).join(" · ") || "—"}</p>
                    </li>
                  ))}
                </ul>
              )}
            </Section>
            <button type="button" className="btn btn-sm btn-ghost" onClick={onShow}>
              {t("tri.account.showRequests")}
            </button>
          </div>
        </div>
      )}
    </li>
  );
}

/* ─── Onglet journal ─────────────────────────────────────────────────────────────────────── */

function RemovedTab({ data, t }: { data: TriPayload; t: TFn }) {
  const size = useSize();
  const d = useDates();
  if (data.removed.length === 0) return <p className="rounded-2xl bg-white/2 px-4 py-6 text-center text-sm text-subtle">{t("tri.log.empty")}</p>;
  return (
    <ul className="divide-y divide-white/5 overflow-hidden rounded-2xl bg-white/2">
      {data.removed.map((r, i) => (
        <li key={`${r.at}-${i}`} className="space-y-1 px-4 py-3">
          <div className="flex flex-wrap items-center gap-2">
            {r.kind === "movie" ? <Film size={13} className="text-subtle" /> : <Tv size={13} className="text-subtle" />}
            <span className="text-sm font-medium text-white">
              {r.title}
              {r.year ? <span className="font-normal text-subtle"> ({r.year})</span> : null}
            </span>
            <Chip tone="bg-success/12 text-success">{r.freedBytes === null ? "?" : size(r.freedBytes)}</Chip>
            {r.steps.some((s) => !s.ok) && <Chip tone="bg-danger/12 text-danger">{t("tri.log.failed")}</Chip>}
          </div>
          <p className="text-xs text-subtle">
            {d.dayTime(r.at)} · {t("tri.log.torrents", { n: r.torrents })}
            {r.requestedBy.length ? ` · ${t("tri.log.requestedBy", { who: r.requestedBy.join(", ") })}` : ""}
          </p>
          {r.steps.some((s) => !s.ok) && (
            <ul className="text-xs text-danger">
              {r.steps
                .filter((s) => !s.ok)
                .map((s) => (
                  <li key={s.step}>
                    {s.step} · {s.detail}
                  </li>
                ))}
            </ul>
          )}
        </li>
      ))}
    </ul>
  );
}

/* ─── La page ────────────────────────────────────────────────────────────────────────────── */

export function Tri() {
  const size = useSize();
  const t = useT();
  const d = useDates();
  const { data, error, isLoading, mutate } = useSWR<TriPayload>(TRI_KEY, fetcher, { revalidateOnFocus: false });
  const [tab, setTab] = useState<Tab>("titles");
  const [account, setAccount] = useState("");
  const [refreshing, setRefreshing] = useState(false);

  const refresh = async () => {
    setRefreshing(true);
    try {
      await mutate((await apiAction(`${TRI_KEY}?force=1`)) as TriPayload, { revalidate: false });
    } finally {
      setRefreshing(false);
    }
  };

  const header = (
    <PageHeader
      title={t("tri.title")}
      subtitle={t("tri.subtitle")}
      action={
        <button type="button" className="btn btn-sm btn-ghost" onClick={refresh} disabled={refreshing}>
          <RefreshCw size={14} className={refreshing ? "animate-spin" : ""} /> {t("tri.refresh")}
        </button>
      }
    />
  );
  if (error) return <div>{header}<ErrorState message={error instanceof Error ? error.message : String(error)} /></div>;
  if (isLoading || !data) return <div>{header}<LoadingState /></div>;

  const never = data.titles.filter(isNeverOpened);
  const neverBytes = never.reduce((a, x) => a + x.sizeBytes, 0);
  const totalBytes = data.titles.reduce((a, x) => a + x.sizeBytes, 0);
  const tabs: { id: Tab; icon: React.ElementType; label: string }[] = [
    { id: "titles", icon: Film, label: t("tri.tab.titles") },
    { id: "accounts", icon: Users, label: t("tri.tab.accounts") },
    { id: "removed", icon: History, label: t("tri.tab.removed") },
  ];

  return (
    <div className="space-y-4">
      {header}
      <div className="grid gap-2 sm:grid-cols-3">
        <div className="rounded-2xl bg-white/3 px-4 py-3">
          <p className="text-xs text-subtle">{t("tri.stat.never")}</p>
          <p className="text-lg font-semibold text-white">
            {never.length} · {size(neverBytes)}
          </p>
        </div>
        <div className="rounded-2xl bg-white/3 px-4 py-3">
          <p className="text-xs text-subtle">{t("tri.stat.library")}</p>
          <p className="text-lg font-semibold text-white">
            {data.titles.length} · {size(totalBytes)}
          </p>
        </div>
        <div className="rounded-2xl bg-white/3 px-4 py-3">
          <p className="flex items-center gap-1 text-xs text-subtle">
            <HardDrive size={12} /> {t("tri.stat.freed")}
          </p>
          <p className="text-lg font-semibold text-success">{size(data.freedBytesTotal)}</p>
        </div>
      </div>
      <p className="text-xs text-subtle">{t("tri.computedAt", { when: d.dayTime(new Date(data.computedAt).toISOString()) })}</p>

      <div className="flex gap-1.5" role="tablist">
        {tabs.map(({ id, icon: Icon, label }) => (
          <button key={id} type="button" role="tab" aria-selected={tab === id} onClick={() => setTab(id)} className={`btn btn-sm ${tab === id ? "btn-on" : "btn-ghost"}`}>
            <Icon size={14} /> {label}
          </button>
        ))}
      </div>

      {tab === "titles" && <TitlesTab data={data} t={t} account={account} setAccount={setAccount} onRemoved={() => void mutate()} />}
      {tab === "accounts" && (
        <ul className="divide-y divide-white/5 overflow-hidden rounded-2xl bg-white/2">
          {[...data.accounts]
            .sort((a, b) => b.requests - a.requests)
            .map((a) => (
              <AccountRow
                key={a.user}
                a={a}
                data={data}
                t={t}
                onShow={() => {
                  setAccount(a.user);
                  setTab("titles");
                }}
              />
            ))}
        </ul>
      )}
      {tab === "removed" && <RemovedTab data={data} t={t} />}
    </div>
  );
}
