"use client";

import Link from "next/link";
import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import useSWRInfinite from "swr/infinite";
import { ArrowLeft, ChevronDown, ChevronRight, Clapperboard, Search } from "lucide-react";
import { fetcher } from "@/lib/swr";
import { PageHeader } from "@/components/PageHeader";
import { LoadingState, ErrorState } from "@/components/StateViews";
import { useT } from "@/components/TranslationProvider";
import { JsonBlock, Steps, describeLine, fullDate, kindTone } from "@/components/activity/parts";

interface LogPage {
  source: string;
  total: number;
  items: (Record<string, unknown> & { _file: string; _line: number; _t: number; _index: number })[];
  nextCursor: number | null;
  facets: { users: string[]; types: { name: string; count: number }[] };
}

const SOURCES = ["player", "server", "bench", "benchPlayer"] as const;
const PERIODS = [1, 7, 30, 0] as const;

/** Une ligne, repliée : l'heure, le type, qui, quoi. Dépliée : la ligne entière, traces comprises. */
function LogLine({ item, source }: { item: LogPage["items"][number]; source: string }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [full, setFull] = useState<Record<string, unknown> | null>(null);
  const [missing, setMissing] = useState(false);
  const kind = String(item.kind ?? item.scope ?? item.level ?? "?");
  const toggle = async () => {
    const next = !open;
    setOpen(next);
    if (next && !full && !missing) {
      const res = await fetch(`/api/admin/activity/logs/line?source=${source}&file=${encodeURIComponent(item._file)}&line=${item._line}`);
      if (res.ok) setFull((await res.json()) as Record<string, unknown>);
      else setMissing(true);
    }
  };
  const summary = describeLine(item, t);
  const shown = full ?? item;
  const { steps, stack, ...rest } = shown as { steps?: unknown; stack?: unknown };
  return (
    <li className="border-b border-white/5">
      <button type="button" onClick={toggle} className="flex w-full items-start gap-3 px-4 py-2 text-left hover:bg-white/[0.03]">
        {open ? <ChevronDown size={14} className="mt-0.5 shrink-0 text-slate-500" /> : <ChevronRight size={14} className="mt-0.5 shrink-0 text-slate-500" />}
        <span className="w-24 shrink-0 font-mono text-[11px] text-slate-500">{fullDate(item._t)}</span>
        <span className={`w-24 shrink-0 truncate rounded px-1.5 py-0.5 text-center font-mono text-[10px] ${kindTone(kind, item.level)}`}>{kind}</span>
        <span className="min-w-0 flex-1 text-sm">
          <span className="flex flex-wrap items-baseline gap-x-2">
            {typeof item.user === "string" && <span className="font-medium text-accent-300">{item.user}</span>}
            {typeof item.title === "string" && <span className="truncate text-slate-200">{item.title}</span>}
          </span>
          {summary && <span className="block break-words text-xs text-slate-400">{summary}</span>}
        </span>
      </button>
      {open && (
        <div className="space-y-2 px-4 pb-3 pl-11">
          {typeof item.session === "string" && source === "player" && (
            <Link href={`/activite/seances/${encodeURIComponent(item.session)}`} className="inline-flex items-center gap-1.5 text-xs text-accent-300 hover:underline">
              <Clapperboard size={13} />
              {t("activity.logs.openSeance")}
            </Link>
          )}
          {missing && <p className="text-xs text-amber-300">{t("activity.logs.rotated")}</p>}
          {typeof steps === "string" && <Steps text={steps} />}
          {typeof stack === "string" && <Steps text={stack} />}
          <JsonBlock value={Object.fromEntries(Object.entries(rest).filter(([k]) => !k.startsWith("_")))} />
        </div>
      )}
    </li>
  );
}

function LogsView() {
  const t = useT();
  const router = useRouter();
  const params = useSearchParams();
  const source = (SOURCES as readonly string[]).includes(params.get("source") ?? "") ? params.get("source")! : "player";
  const user = params.get("user") ?? "";
  const type = params.get("type") ?? "";
  const days = Number(params.get("days") ?? 7);
  const q = params.get("q") ?? "";
  const session = params.get("session") ?? "";
  const [draft, setDraft] = useState(q);

  const set = (patch: Record<string, string | number | null>) => {
    const next = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(patch)) {
      if (v === null || v === "" || (k === "days" && v === 7)) next.delete(k);
      else next.set(k, String(v));
    }
    router.replace(`/activite/journaux${next.size ? `?${next}` : ""}`);
  };

  const base = new URLSearchParams({ source, days: String(days), ...(user && { user }), ...(type && { type }), ...(q && { q }), ...(session && { session }) });
  const { data, error, isLoading, size, setSize, mutate } = useSWRInfinite<LogPage>(
    (index, previous) => {
      if (previous && previous.nextCursor === null) return null;
      const cursor = previous?.nextCursor;
      return `/api/admin/activity/logs?${base}${index && cursor ? `&cursor=${cursor}` : ""}`;
    },
    fetcher
  );

  const first = data?.[0];
  const items = data?.flatMap((page) => page.items) ?? [];
  const more = data?.[data.length - 1]?.nextCursor != null;

  return (
    <div className="space-y-4">
      <Link href="/activite" className="inline-flex items-center gap-1.5 text-sm text-slate-400 hover:text-white">
        <ArrowLeft size={15} />
        {t("activity.title")}
      </Link>
      <PageHeader title={t("activity.logs.title")} subtitle={first ? t("activity.logs.subtitle", { n: first.total }) : undefined} />

      {/* Les filtres, gardés dans l'adresse : un lien vers une recherche la retrouve telle quelle. */}
      <div className="card space-y-3 p-3">
        <div className="flex flex-wrap gap-1">
          {SOURCES.map((key) => (
            <button
              key={key}
              type="button"
              onClick={() => set({ source: key, type: null, user: null, session: null })}
              className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${source === key ? "bg-accent-500/20 text-accent-200" : "text-slate-400 hover:bg-white/5 hover:text-white"}`}
            >
              {t(`activity.logs.sources.${key}`)}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <select value={user} onChange={(e) => set({ user: e.target.value })} className="input h-9 w-auto text-xs" aria-label={t("activity.logs.user")}>
            <option value="">{t("activity.logs.allUsers")}</option>
            {first?.facets.users.map((u) => (
              <option key={u} value={u}>
                {u}
              </option>
            ))}
          </select>
          <select value={type} onChange={(e) => set({ type: e.target.value })} className="input h-9 w-auto text-xs" aria-label={t("activity.logs.type")}>
            <option value="">{t("activity.logs.allTypes")}</option>
            {first?.facets.types.map((ty) => (
              <option key={ty.name} value={ty.name}>
                {ty.name} ({ty.count})
              </option>
            ))}
          </select>
          <select value={days} onChange={(e) => set({ days: Number(e.target.value) })} className="input h-9 w-auto text-xs" aria-label={t("activity.logs.period")}>
            {PERIODS.map((p) => (
              <option key={p} value={p}>
                {p ? t("activity.logs.lastDays", { n: p }) : t("activity.logs.allTime")}
              </option>
            ))}
          </select>
          <form
            className="flex min-w-[12rem] flex-1 items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              set({ q: draft.trim() });
            }}
          >
            <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder={t("activity.logs.search")} className="input h-9 flex-1 text-xs" />
            <button type="submit" className="btn-ghost h-9 px-3 text-xs">
              <Search size={14} />
            </button>
          </form>
          {session && (
            <button type="button" onClick={() => set({ session: null })} className="rounded bg-accent-500/15 px-2 py-1 text-xs text-accent-200">
              {t("activity.logs.sessionFilter", { id: session })} ×
            </button>
          )}
        </div>
      </div>

      {isLoading && !data ? (
        <LoadingState />
      ) : error ? (
        <ErrorState message={t("activity.loadError")} onRetry={() => mutate()} />
      ) : items.length ? (
        <section className="card overflow-hidden">
          <ul>
            {items.map((item) => (
              <LogLine key={`${item._file}:${item._line}`} item={item} source={source} />
            ))}
          </ul>
          {more && (
            <div className="p-3 text-center">
              <button type="button" onClick={() => setSize(size + 1)} className="btn-ghost px-4 py-1.5 text-xs">
                {t("activity.logs.more")}
              </button>
            </div>
          )}
        </section>
      ) : (
        <p className="card px-4 py-10 text-center text-sm text-slate-500">{t("activity.logs.empty")}</p>
      )}
    </div>
  );
}

export default function LogsPage() {
  // `useSearchParams` dans une page client demande une frontière de suspension à Next.
  return (
    <Suspense fallback={<LoadingState />}>
      <LogsView />
    </Suspense>
  );
}
