"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import useSWR from "swr";
import useSWRInfinite from "swr/infinite";
import { ChevronDown, ChevronRight, Clapperboard, RefreshCw, Search } from "lucide-react";
import { fetcher } from "@/lib/swr";
import { LoadingState, ErrorState } from "@/components/StateViews";
import { useT } from "@/components/TranslationProvider";
import { JsonBlock, Steps, TimelineTable, describeLine, fullDate, kindTone } from "@/components/activity/parts";
import { ActivityLink, type LogsPreset } from "@/components/activity/nav";

type LogItem = Record<string, unknown> & { _file: string; _line: number; _t: number };

interface LogPage {
  source: string;
  /** Combien de fichiers ce journal compte : le courant et ses archives. */
  generations: number;
  items: LogItem[];
  /** `génération.ligne`, ou rien quand on est au bout. */
  nextCursor: string | null;
  /** Sur la première page seulement, comptés sur la période ; `partial` quand la borne d'archives a coupé. */
  facets?: { users: string[]; types: { name: string; count: number }[]; recentLines: number; partial?: boolean };
}

const SOURCES = ["player", "server", "auth", "notifications", "startup", "bench", "benchPlayer", "subtitleGen"] as const;
const PERIODS = [1, 7, 30, 0] as const;
/** Le rafraîchissement automatique : assez vif pour suivre une séance en cours, sans tenir le serveur. */
const LIVE_REFRESH_MS = 20_000;

/**
 * La période affichée inclut-elle aujourd'hui ? Toutes celles proposées — « les N derniers jours »,
 * « Tout » — finissent maintenant : elles l'incluent toutes. Une période fermée, le jour où elle
 * existera, coupera ici le rafraîchissement automatique — ses lignes ne bougent plus.
 */
export function periodIncludesToday(days: number): boolean {
  return Number.isFinite(days) && days >= 0;
}

/**
 * Les lignes arrivées depuis le chargement de la liste : celles de `head` (la première page relue,
 * de la plus récente à la plus ancienne) qui précèdent `top`, la première ligne déjà affichée.
 * Une ligne est reconnue à son instant et à son rang — pas à son fichier : une rotation renomme
 * `player.log` en `.1` sans changer ni l'un ni l'autre. `gap` : toute la page relue est neuve et il
 * y en a d'autres derrière — plus de cent lignes en vingt secondes, la liste ne se raccorde plus.
 */
export function freshLines(head: LogItem[] | undefined, top: LogItem | undefined, headHasMore: boolean): { lines: LogItem[]; gap: boolean } {
  if (!head?.length) return { lines: [], gap: false };
  if (!top) return { lines: head, gap: false };
  const seam = head.findIndex((i) => i._t < top._t || (i._t === top._t && i._line === top._line));
  if (seam === -1) return { lines: head, gap: headHasMore };
  return { lines: head.slice(0, seam), gap: false };
}

/** Le conteneur qui fait défiler la liste : le panneau de l'activité, ou la page. */
function scrollParent(el: HTMLElement): HTMLElement | null {
  for (let node = el.parentElement; node; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node);
    if ((overflowY === "auto" || overflowY === "scroll") && node.scrollHeight > node.clientHeight) return node;
  }
  return null;
}

/**
 * Un repère posé entre les lignes arrivées et la liste chargée, qui garde la position de lecture
 * quand des lignes s'ajoutent en tête : si on lisait plus bas (le repère au-dessus de la vue), le
 * défilement avance d'autant que le repère est descendu. Sans lui, chaque rafraîchissement faisait
 * glisser sous les yeux la ligne qu'on lisait. Sa position est relevée à chaque défilement : un
 * moteur qui ancre le défilement de lui-même (Chromium) l'a déjà compensé, l'écart est alors nul —
 * jamais deux fois. Seule une **hausse** du nombre de lignes arrivées déplace : quand « Actualiser »
 * les reverse dans la liste, la ligne lue n'a pas bougé.
 */
function ReadingAnchor({ count }: { count: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const last = useRef<{ top: number; above: boolean; count: number } | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const target: HTMLElement | Window = scrollParent(el) ?? window;
    const onScroll = () => {
      last.current = { ...anchorPlace(el), count: last.current?.count ?? 0 };
    };
    target.addEventListener("scroll", onScroll, { passive: true });
    return () => target.removeEventListener("scroll", onScroll);
  }, []);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const before = last.current;
    if (before?.above && count > before.count) {
      const delta = el.getBoundingClientRect().top - before.top;
      if (delta > 0) {
        const scroller = scrollParent(el);
        if (scroller) scroller.scrollTop += delta;
        else window.scrollBy(0, delta);
      }
    }
    last.current = { ...anchorPlace(el), count };
  }, [count]);
  return <div ref={ref} aria-hidden />;
}

/** Où est le repère : son haut à l'écran, et s'il est passé au-dessus de la partie visible. */
function anchorPlace(el: HTMLElement): { top: number; above: boolean } {
  const scroller = scrollParent(el);
  const top = el.getBoundingClientRect().top;
  return { top, above: top < (scroller ? scroller.getBoundingClientRect().top : 0) };
}

/** Une ligne, repliée : l'heure, le type, qui, quoi. Dépliée : la ligne entière, traces comprises. */
function LogLine({ item, source }: { item: LogItem; source: string }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [full, setFull] = useState<Record<string, unknown> | null>(null);
  const [missing, setMissing] = useState(false);
  const kind = String(item.kind ?? item.scope ?? item.level ?? "?");
  const toggle = async () => {
    const next = !open;
    setOpen(next);
    if (next && !full && !missing) {
      const res = await fetch(`/api/admin/activity/logs/line?source=${source}&file=${encodeURIComponent(item._file)}&line=${item._line}&at=${item._t}`);
      if (res.ok) setFull((await res.json()) as Record<string, unknown>);
      else setMissing(true);
    }
  };
  const summary = describeLine(item, t);
  const shown = full ?? item;
  const { steps, stack, timeline, ...rest } = shown as { steps?: unknown; stack?: unknown; timeline?: unknown };
  return (
    <li className="border-b border-white/5">
      {/* Sur téléphone, la date et le type sur une ligne, le texte en dessous sur toute la largeur ;
          sur grand écran, des colonnes alignées (`sm:contents` fait des deux premiers des cellules). */}
      <button
        type="button"
        onClick={toggle}
        className="grid w-full grid-cols-[auto_minmax(0,1fr)] items-start gap-x-3 gap-y-1 px-4 py-2 text-left hover:bg-white/[0.03] sm:grid-cols-[auto_9rem_6rem_minmax(0,1fr)]"
      >
        {open ? <ChevronDown size={14} className="mt-0.5 shrink-0 text-subtle" /> : <ChevronRight size={14} className="mt-0.5 shrink-0 text-subtle" />}
        <span className="flex items-center gap-2 sm:contents">
          <span className="whitespace-nowrap font-mono text-[11px] text-subtle">{fullDate(item._t, { seconds: true })}</span>
          <span className={`truncate rounded px-1.5 py-0.5 text-center font-mono text-[11px] sm:w-24 ${kindTone(kind, item.level, item.event)}`}>{kind}</span>
        </span>
        <span className="col-start-2 min-w-0 text-sm sm:col-start-auto">
          <span className="flex flex-wrap items-baseline gap-x-2">
            {typeof item.user === "string" && <span className="font-medium text-accent-400">{item.user}</span>}
            {typeof item.title === "string" && <span className="truncate text-white">{item.title}</span>}
          </span>
          {summary && <span className="block break-words text-xs text-muted">{summary}</span>}
        </span>
      </button>
      {open && (
        <div className="space-y-2 px-4 pb-3 sm:pl-11">
          {typeof item.session === "string" && source === "player" && (
            <ActivityLink to={{ kind: "seance", id: item.session }} className="inline-flex items-center gap-1.5 text-xs text-accent-400 hover:underline">
              <Clapperboard size={13} />
              {t("activity.logs.openSeance")}
            </ActivityLink>
          )}
          {missing && <p className="text-xs text-warning">{t("activity.logs.rotated")}</p>}
          {typeof steps === "string" && <Steps text={steps} />}
          {typeof stack === "string" && <Steps text={stack} />}
          {/* Les deux dernières minutes d'un incident (§77) : en tableau, comme dans la séance. */}
          {typeof timeline === "string" && <TimelineTable text={timeline} />}
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
  const { data, error, isLoading, isValidating, size, setSize, mutate } = useSWRInfinite<LogPage>(
    (index, previous) => {
      if (previous && previous.nextCursor === null) return null;
      const cursor = previous?.nextCursor;
      return `/api/admin/activity/logs?${base}${index && cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
    },
    fetcher,
    // Les pages chargées ne se relisent pas d'elles-mêmes : relire la première décale le curseur de
    // toutes les suivantes, qui se rechargeraient toutes. Les lignes neuves passent par `head`.
    { revalidateOnFocus: false, revalidateOnReconnect: false, revalidateFirstPage: false }
  );

  const first = data?.[0];
  const loaded = data?.flatMap((page) => page.items) ?? [];
  const more = data?.[data.length - 1]?.nextCursor != null;

  // Le rafraîchissement automatique (14/10/2026) : la première page relue toutes les 20 s, page
  // visible seulement (SWR saute un tour quand l'onglet est caché), sans les filtres (`facets=0`).
  // Pas de lecture au montage : la liste vient d'être chargée. Les lignes plus récentes que la
  // première affichée s'ajoutent en tête ; les pages déjà chargées ne bougent pas.
  const live = periodIncludesToday(days) && !!data && !error;
  const { data: head } = useSWR<LogPage>(live ? `/api/admin/activity/logs?${base}&facets=0` : null, fetcher, {
    refreshInterval: LIVE_REFRESH_MS,
    revalidateOnMount: false,
    revalidateOnFocus: false,
  });
  // Une liste vide au chargement (`loaded[0]` absent) : tout ce que la relecture trouve est neuf.
  const fresh = freshLines(head?.items, loaded[0], head?.nextCursor != null);
  const freshItems = fresh.lines;
  const items = [...freshItems, ...loaded];

  // « Actualiser » : toute la liste relue depuis la plus récente ; les lignes arrivées y rentrent.
  const refresh = () => void mutate();

  return (
    <div className="space-y-4">
      {first && <p className="text-sm text-muted">{t("activity.logs.subtitle", { n: first.generations })}</p>}

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
              className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${source === key ? "bg-accent-500/20 text-accent-100" : "text-muted hover:bg-white/5 hover:text-white"}`}
            >
              {t(`activity.logs.sources.${key}`)}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <select value={user} onChange={(e) => setUser(e.target.value)} className="input h-9 w-auto text-xs" aria-label={t("activity.logs.user")}>
            <option value="">{t("activity.logs.allUsers")}</option>
            {first?.facets?.users.map((u) => (
              <option key={u} value={u}>
                {u}
              </option>
            ))}
          </select>
          <select value={type} onChange={(e) => setType(e.target.value)} className="input h-9 w-auto text-xs" aria-label={t("activity.logs.type")}>
            <option value="">{t("activity.logs.allTypes")}</option>
            {first?.facets?.types.map((ty) => (
              <option key={ty.name} value={ty.name}>
                {ty.name} ({ty.count}
                {first?.facets?.partial ? "+" : ""})
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
          <button
            type="button"
            onClick={refresh}
            disabled={isValidating}
            className="btn-ghost h-9 gap-1.5 px-3 text-xs"
            aria-label={t("activity.logs.refresh")}
            title={t("activity.logs.refresh")}
          >
            <RefreshCw size={14} className={isValidating ? "animate-spin" : undefined} />
            <span className="hidden sm:inline">{t("activity.logs.refresh")}</span>
          </button>
          {session && (
            <button type="button" onClick={() => setSession("")} className="rounded bg-accent-500/15 px-2 py-1 text-xs text-accent-100">
              {t("activity.logs.sessionFilter", { id: session })} ×
            </button>
          )}
        </div>
      </div>

      {isLoading && !data ? (
        <LoadingState />
      ) : error && !data ? (
        <ErrorState message={t("activity.loadError")} onRetry={() => mutate()} />
      ) : items.length || more ? (
        // Une page vide n'est pas la fin : les archives plus anciennes peuvent encore porter des
        // lignes du filtre (`nextCursor`). « Aucune ligne » et la disparition de « Plus » cachaient
        // celles-là (08/10/2026).
        // `overflow-anchor: none` : la position de lecture est tenue par `ReadingAnchor`, une seule fois.
        <section className="card overflow-hidden [overflow-anchor:none]">
          {freshItems.length > 0 && (
            <ul data-testid="log-fresh">
              {freshItems.map((item) => (
                <LogLine key={`fresh:${item._t}:${item._line}`} item={item} source={source} />
              ))}
            </ul>
          )}
          {fresh.gap && loaded.length > 0 && (
            <button type="button" onClick={refresh} className="block w-full border-b border-white/5 px-4 py-2 text-center text-xs text-warning hover:bg-white/[0.03]">
              {t("activity.logs.gap")}
            </button>
          )}
          <ReadingAnchor count={freshItems.length} />
          {loaded.length ? (
            <ul>
              {loaded.map((item) => (
                <LogLine key={`${item._file}:${item._line}`} item={item} source={source} />
              ))}
            </ul>
          ) : freshItems.length ? null : (
            <p className="px-4 py-6 text-center text-sm text-subtle">{t("activity.logs.empty")}</p>
          )}
          {more && (
            <div className="p-3 text-center">
              <button type="button" onClick={() => setSize(size + 1)} className="btn-ghost px-4 py-1.5 text-xs">
                {t("activity.logs.more")}
              </button>
            </div>
          )}
        </section>
      ) : (
        <p className="card px-4 py-10 text-center text-sm text-subtle">{t("activity.logs.empty")}</p>
      )}
    </div>
  );
}
