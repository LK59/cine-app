"use client";

import { useState } from "react";
import useSWRInfinite from "swr/infinite";
import { ChevronDown, ChevronRight, Clapperboard, Search } from "lucide-react";
import { fetcher } from "@/lib/swr";
import { LoadingState, ErrorState } from "@/components/StateViews";
import { useT } from "@/components/TranslationProvider";
import { JsonBlock, Steps, describeLine, fullDate, kindTone } from "@/components/activity/parts";
import { ActivityLink, type LogsPreset } from "@/components/activity/nav";

interface LogPage {
  source: string;
  /** Combien de fichiers ce journal compte : le courant et ses archives. */
  generations: number;
  items: (Record<string, unknown> & { _file: string; _line: number; _t: number })[];
  /** `génération.ligne`, ou rien quand on est au bout. */
  nextCursor: string | null;
  facets: { users: string[]; types: { name: string; count: number }[]; recentLines: number };
}

const SOURCES = ["player", "server", "auth", "notifications", "bench", "benchPlayer"] as const;
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
      {/* Sur téléphone, la date et le type sur une ligne, le texte en dessous sur toute la largeur ;
          sur grand écran, des colonnes alignées (`sm:contents` fait des deux premiers des cellules). */}
      <button
        type="button"
        onClick={toggle}
        className="grid w-full grid-cols-[auto_minmax(0,1fr)] items-start gap-x-3 gap-y-1 px-4 py-2 text-left hover:bg-white/[0.03] sm:grid-cols-[auto_7.5rem_6rem_minmax(0,1fr)]"
      >
        {open ? <ChevronDown size={14} className="mt-0.5 shrink-0 text-slate-500" /> : <ChevronRight size={14} className="mt-0.5 shrink-0 text-slate-500" />}
        <span className="flex items-center gap-2 sm:contents">
          <span className="whitespace-nowrap font-mono text-[11px] text-slate-500">{fullDate(item._t)}</span>
          <span className={`truncate rounded px-1.5 py-0.5 text-center font-mono text-[10px] sm:w-24 ${kindTone(kind, item.level)}`}>{kind}</span>
        </span>
        <span className="col-start-2 min-w-0 text-sm sm:col-start-auto">
          <span className="flex flex-wrap items-baseline gap-x-2">
            {typeof item.user === "string" && <span className="font-medium text-accent-300">{item.user}</span>}
            {typeof item.title === "string" && <span className="truncate text-slate-200">{item.title}</span>}
          </span>
          {summary && <span className="block break-words text-xs text-slate-400">{summary}</span>}
        </span>
      </button>
      {open && (
        <div className="space-y-2 px-4 pb-3 sm:pl-11">
          {typeof item.session === "string" && source === "player" && (
            <ActivityLink to={{ kind: "seance", id: item.session }} className="inline-flex items-center gap-1.5 text-xs text-accent-300 hover:underline">
              <Clapperboard size={13} />
              {t("activity.logs.openSeance")}
            </ActivityLink>
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

/**
 * Les journaux, filtrés. Les filtres de départ viennent de l'adresse (un lien « les erreurs du
 * serveur », « les lignes de cette séance ») ; les changer ne touche plus à l'adresse — ce sont des
 * réglages de l'écran, pas des écrans à retrouver par le retour.
 */
export function ActivityLogs({ preset }: { preset: LogsPreset }) {
  const t = useT();
  const [source, setSource] = useState((SOURCES as readonly string[]).includes(preset.source ?? "") ? preset.source! : "player");
  const [user, setUser] = useState(preset.user ?? "");
  const [type, setType] = useState(preset.type ?? "");
  const [days, setDays] = useState(preset.days ?? 7);
  const [q, setQ] = useState("");
  const [session, setSession] = useState(preset.session ?? "");
  const [draft, setDraft] = useState("");

  const base = new URLSearchParams({ source, days: String(days), ...(user && { user }), ...(type && { type }), ...(q && { q }), ...(session && { session }) });
  const { data, error, isLoading, size, setSize, mutate } = useSWRInfinite<LogPage>(
    (index, previous) => {
      if (previous && previous.nextCursor === null) return null;
      const cursor = previous?.nextCursor;
      return `/api/admin/activity/logs?${base}${index && cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
    },
    fetcher
  );

  const first = data?.[0];
  const items = data?.flatMap((page) => page.items) ?? [];
  const more = data?.[data.length - 1]?.nextCursor != null;

  return (
    <div className="space-y-4">
      {first && <p className="text-sm text-slate-400">{t("activity.logs.subtitle", { n: first.generations })}</p>}

      <div className="card space-y-3 p-3">
        <div className="flex flex-wrap gap-1">
          {SOURCES.map((key) => (
            <button
              key={key}
              type="button"
              onClick={() => {
                setSource(key);
                setType("");
                setUser("");
                setSession("");
              }}
              className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${source === key ? "bg-accent-500/20 text-accent-200" : "text-slate-400 hover:bg-white/5 hover:text-white"}`}
            >
              {t(`activity.logs.sources.${key}`)}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <select value={user} onChange={(e) => setUser(e.target.value)} className="input h-9 w-auto text-xs" aria-label={t("activity.logs.user")}>
            <option value="">{t("activity.logs.allUsers")}</option>
            {first?.facets.users.map((u) => (
              <option key={u} value={u}>
                {u}
              </option>
            ))}
          </select>
          <select value={type} onChange={(e) => setType(e.target.value)} className="input h-9 w-auto text-xs" aria-label={t("activity.logs.type")}>
            <option value="">{t("activity.logs.allTypes")}</option>
            {first?.facets.types.map((ty) => (
              <option key={ty.name} value={ty.name}>
                {ty.name} ({ty.count})
              </option>
            ))}
          </select>
          <select value={days} onChange={(e) => setDays(Number(e.target.value))} className="input h-9 w-auto text-xs" aria-label={t("activity.logs.period")}>
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
              setQ(draft.trim());
            }}
          >
            <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder={t("activity.logs.search")} className="input h-9 flex-1 text-xs" />
            <button type="submit" className="btn-ghost h-9 px-3 text-xs">
              <Search size={14} />
            </button>
          </form>
          {session && (
            <button type="button" onClick={() => setSession("")} className="rounded bg-accent-500/15 px-2 py-1 text-xs text-accent-200">
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
