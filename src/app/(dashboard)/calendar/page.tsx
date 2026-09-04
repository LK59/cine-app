"use client";

import { useState, useMemo, useRef } from "react";
import Link from "next/link";
import useSWR from "swr";
import { fetcher } from "@/lib/swr";
import { PageHeader } from "@/components/PageHeader";
import { LoadingState } from "@/components/StateViews";
import { WatchlistButton } from "@/components/WatchlistButton";
import type { CalendarEvent } from "@/app/api/calendar/route";
import { ChevronLeft, ChevronRight, LayoutList, CalendarDays, Clapperboard, Film, Tv, CirclePlus, X } from "lucide-react";
import { useT, useLocale } from "@/components/TranslationProvider";
import { getDateLocale } from "@/lib/i18n";
import { usePersistentState } from "@/lib/usePersistentState";
import { apiAction } from "@/lib/apiAction";
import { useToast } from "@/components/Toast";

// ── helpers ──────────────────────────────────────────────────────────────────

function isoDate(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const SOURCE_STYLE: Record<CalendarEvent["source"], { dot: string; badge: string; labelKey: string }> = {
  "cinema":        { dot: "bg-emerald-400", badge: "bg-emerald-500/15 text-emerald-400", labelKey: "calendar.sources.cinema" },
  "upcoming":      { dot: "bg-amber-400",   badge: "bg-amber-500/15 text-amber-400",     labelKey: "calendar.sources.upcoming" },
  "library-movie": { dot: "bg-accent-400",  badge: "bg-accent-500/15 text-accent-400",   labelKey: "calendar.sources.libraryMovie" },
  "library-series":{ dot: "bg-sky-400",     badge: "bg-sky-500/15 text-sky-400",         labelKey: "calendar.sources.librarySeries" },
};

type ViewMode = "month" | "list";
type FilterMode = "all" | "cinema" | "library";

// ── Action buttons for non-library events ─────────────────────────────────────

function EventActions({ ev, compact = false }: { ev: CalendarEvent; compact?: boolean }) {
  const t = useT();
  const toast = useToast();
  const [requesting, setRequesting] = useState(false);
  const [requested, setRequested]   = useState(false);

  if (ev.source === "library-movie" || ev.source === "library-series") return null;
  if (!ev.tmdbId) return null;

  // Le bouton ne s'annonce « demandé » que si Jellyseerr l'a bien dit. Avant, il le disait
  // quoi qu'il arrive, y compris quand la demande était refusée.
  async function doRequest(e: React.MouseEvent) {
    e.preventDefault(); e.stopPropagation();
    setRequesting(true);
    try {
      await apiAction("/api/jellyseerr/requests", {
        method: "POST",
        body: JSON.stringify({ mediaType: ev.type === "series" ? "tv" : "movie", mediaId: ev.tmdbId }),
      });
      setRequested(true);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('common.error'));
    } finally {
      setRequesting(false);
    }
  }

  if (compact) {
    return (
      <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
        <WatchlistButton tmdbId={ev.tmdbId} mediaType="movie" title={ev.title} size="sm" posterPath={ev.posterPath} />
        <button
          onClick={doRequest}
          disabled={requesting || requested}
          className={`flex items-center gap-1 rounded px-1.5 py-1 text-[10px] font-medium transition-colors ${
            requested ? "bg-emerald-500/20 text-emerald-400" : "bg-sky-500/15 text-sky-300 hover:bg-sky-500/25"
          }`}
        >
          <CirclePlus size={9} />
          {requested ? t('calendar.actionRequested') : requesting ? "…" : t('calendar.actionRequest')}
        </button>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
      <WatchlistButton tmdbId={ev.tmdbId} mediaType="movie" title={ev.title} size="sm" posterPath={ev.posterPath} />
      <button
        onClick={doRequest}
        disabled={requesting || requested}
        className={`flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium transition-colors ${
          requested ? "bg-emerald-500/15 text-emerald-400" : "bg-sky-500/15 text-sky-300 hover:bg-sky-500/25"
        }`}
      >
        <CirclePlus size={12} />
        {requested ? t('calendar.actionRequested') : requesting ? t('calendar.actionRequesting') : t('calendar.actionRequest')}
      </button>
    </div>
  );
}

// ── Selected event detail panel (for month grid) ──────────────────────────────

function EventDetailPanel({ ev, onClose }: { ev: CalendarEvent; onClose: () => void }) {
  const t = useT();
  const style = SOURCE_STYLE[ev.source];
  const isLibrary = ev.source === "library-movie" || ev.source === "library-series";
  return (
    <div className="mt-3 rounded-xl border border-white/10 bg-slate-900/90 backdrop-blur-xs p-4 flex gap-4 items-start">
      <div className="h-20 w-14 shrink-0 overflow-hidden rounded-lg bg-slate-800">
        {ev.posterPath
          // eslint-disable-next-line @next/next/no-img-element
          ? <img src={ev.posterPath} alt={ev.title} className="h-full w-full object-cover" />
          : <div className="flex h-full items-center justify-center"><Film size={16} className="text-slate-600" /></div>
        }
      </div>
      <div className="min-w-0 flex-1">
        <div className="mb-1 flex items-center gap-2">
          <span className={`rounded-sm px-1.5 py-0.5 text-[10px] font-semibold ${style.badge}`}>{t(style.labelKey)}</span>
          <span className="text-xs text-slate-500">{new Date(ev.date + "T12:00:00").toLocaleDateString(undefined, { day: "numeric", month: "long" })}</span>
        </div>
        <p className="font-semibold text-white">{ev.title}</p>
        {ev.detail && <p className="mt-0.5 text-xs text-slate-400">{ev.detail}</p>}
        <div className="mt-3">
          {isLibrary && ev.href
            ? <Link href={ev.href} className="inline-flex items-center gap-1.5 rounded-lg bg-accent-600/20 px-3 py-1.5 text-xs font-medium text-accent-400 hover:bg-accent-600/30">{t('calendar.viewSheet')}</Link>
            : <EventActions ev={ev} />
          }
        </div>
      </div>
      <button onClick={onClose} className="shrink-0 text-slate-500 hover:text-white transition-colors">
        <X size={14} />
      </button>
    </div>
  );
}

// ── Event pill (month grid) ───────────────────────────────────────────────────

function EventPill({ ev, onSelect }: { ev: CalendarEvent; onSelect: (ev: CalendarEvent) => void }) {
  const style = SOURCE_STYLE[ev.source];
  const isLibrary = ev.source === "library-movie" || ev.source === "library-series";

  const inner = (
    <div className={`flex items-center gap-1 rounded-sm px-1 py-0.5 text-[10px] font-medium truncate cursor-pointer ${style.badge} hover:opacity-80`}>
      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${style.dot}`} />
      <span className="truncate">{ev.title}</span>
    </div>
  );

  if (isLibrary && ev.href) return <Link href={ev.href}>{inner}</Link>;
  return <div onClick={() => onSelect(ev)}>{inner}</div>;
}

// ── Month grid ────────────────────────────────────────────────────────────────

function MonthGrid({ year, month, eventsByDate, today, selectedEvent, onSelectEvent, detailRef }: {
  year: number;
  month: number;
  eventsByDate: Map<string, CalendarEvent[]>;
  today: string;
  selectedEvent: CalendarEvent | null;
  onSelectEvent: (ev: CalendarEvent | null) => void;
  detailRef: React.RefObject<HTMLDivElement | null>;
}) {
  const t = useT();
  const firstDay    = new Date(year, month, 1);
  const lastDay     = new Date(year, month + 1, 0);
  const startOffset = (firstDay.getDay() + 6) % 7;
  const days: Array<{ date: string; inMonth: boolean }> = [];

  for (let i = 0; i < startOffset; i++) {
    days.push({ date: isoDate(new Date(year, month, 1 - (startOffset - i))), inMonth: false });
  }
  for (let d = 1; d <= lastDay.getDate(); d++) {
    days.push({ date: isoDate(new Date(year, month, d)), inMonth: true });
  }
  const trailing = (7 - (days.length % 7)) % 7;
  for (let i = 1; i <= trailing; i++) {
    days.push({ date: isoDate(new Date(year, month + 1, i)), inMonth: false });
  }

  const HEADERS = [t('calendar.days.mon'), t('calendar.days.tue'), t('calendar.days.wed'), t('calendar.days.thu'), t('calendar.days.fri'), t('calendar.days.sat'), t('calendar.days.sun')];

  return (
    <>
      <div className="rounded-xl border border-white/5 bg-white/2 overflow-hidden">
        <div className="grid grid-cols-7 border-b border-white/5">
          {HEADERS.map((h) => (
            <div key={h} className="py-2 text-center text-[11px] font-semibold text-slate-500 uppercase tracking-wide">{h}</div>
          ))}
        </div>
        <div className="grid grid-cols-7">
          {days.map((day, i) => {
            const evs = eventsByDate.get(day.date) ?? [];
            const isToday = day.date === today;
            const MAX_SHOWN = 3;
            return (
              <div
                key={`${day.date}-${i}`}
                className={`min-h-[80px] p-1 border-b border-r border-white/4 ${!day.inMonth ? "opacity-30" : ""}`}
              >
                <div className={`mb-1 flex h-5 w-5 items-center justify-center rounded-full text-[11px] font-medium ${
                  isToday ? "bg-accent-500 text-white" : "text-slate-400"
                }`}>
                  {Number(day.date.slice(8))}
                </div>
                <div className="space-y-0.5">
                  {evs.slice(0, MAX_SHOWN).map((ev) => (
                    <EventPill key={ev.id} ev={ev} onSelect={onSelectEvent} />
                  ))}
                  {evs.length > MAX_SHOWN && (
                    <button
                      onClick={() => onSelectEvent(evs[MAX_SHOWN])}
                      className="pl-1 text-[10px] text-slate-500 hover:text-slate-300"
                    >
                      {t('calendar.moreItems', { n: evs.length - MAX_SHOWN })}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
      {selectedEvent && (
        <div ref={detailRef}>
          <EventDetailPanel ev={selectedEvent} onClose={() => onSelectEvent(null)} />
        </div>
      )}
    </>
  );
}

// ── List view ─────────────────────────────────────────────────────────────────

function ListView({ events, today, dateLocale }: { events: CalendarEvent[]; today: string; dateLocale: string }) {
  const t = useT();
  const groups = useMemo(() => {
    const map = new Map<string, CalendarEvent[]>();
    for (const ev of events) {
      const arr = map.get(ev.date) ?? [];
      arr.push(ev);
      map.set(ev.date, arr);
    }
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [events]);

  return (
    <div className="space-y-6">
      {groups.map(([date, dayEvs]) => {
        const isToday = date === today;
        const label = new Date(date + "T12:00:00").toLocaleDateString(dateLocale, {
          weekday: "long", day: "numeric", month: "long",
        });
        return (
          <div key={date}>
            <h2 className={`mb-2 text-sm font-semibold ${isToday ? "text-accent-400" : "text-slate-400"}`}>
              {label}{isToday && ` · ${t('calendar.todaySuffix')}`}
            </h2>
            <div className="card divide-y divide-white/5">
              {dayEvs.map((ev) => {
                const style = SOURCE_STYLE[ev.source];
                const isLibrary = ev.source === "library-movie" || ev.source === "library-series";
                const row = (
                  <div className="flex items-center gap-3 p-3 hover:bg-white/3 transition-colors">
                    <div className="h-14 w-10 shrink-0 overflow-hidden rounded-sm bg-slate-800">
                      {ev.posterPath
                        // eslint-disable-next-line @next/next/no-img-element
                        ? <img src={ev.posterPath} alt={ev.title} className="h-full w-full object-cover" />
                        : <div className="flex h-full items-center justify-center">
                            {ev.type === "series" ? <Tv size={12} className="text-slate-600" /> : <Film size={12} className="text-slate-600" />}
                          </div>
                      }
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-white">{ev.title}</p>
                      {ev.detail && <p className="truncate text-xs text-slate-500">{ev.detail}</p>}
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      {!isLibrary && <EventActions ev={ev} compact />}
                      <span className={`rounded-sm px-2 py-0.5 text-[10px] font-semibold ${style.badge}`}>{t(style.labelKey)}</span>
                    </div>
                  </div>
                );
                return isLibrary && ev.href
                  ? <Link key={ev.id} href={ev.href}>{row}</Link>
                  : <div key={ev.id}>{row}</div>;
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function CalendarPage() {
  const t = useT();
  const { locale } = useLocale();
  const dateLocale = getDateLocale(locale);
  const today = useMemo(() => isoDate(new Date()), []);
  const [view, setView]       = usePersistentState<ViewMode>("calendar.view", "month");
  const [filter, setFilter]   = usePersistentState<FilterMode>("calendar.filter", "all");
  const [selectedEvent, setSelectedEvent] = useState<CalendarEvent | null>(null);
  const detailRef = useRef<HTMLDivElement>(null);

  function selectEvent(ev: CalendarEvent | null) {
    setSelectedEvent(ev);
    if (ev) {
      // Scroll to detail panel after render
      setTimeout(() => detailRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" }), 50);
    }
  }

  const [navYear, setNavYear]   = useState(() => new Date().getFullYear());
  const [navMonth, setNavMonth] = useState(() => new Date().getMonth());

  const fetchStart = useMemo(() => isoDate(new Date(navYear, navMonth - 1, 1)), [navYear, navMonth]);
  const fetchEnd   = useMemo(() => isoDate(new Date(navYear, navMonth + 2, 0)), [navYear, navMonth]);

  const { data, isLoading } = useSWR<{ events: CalendarEvent[] }>(
    `/api/calendar?start=${fetchStart}&end=${fetchEnd}`,
    fetcher,
    { keepPreviousData: true }
  );

  const filtered = useMemo(() => {
    const evs = data?.events ?? [];
    if (filter === "cinema")  return evs.filter((e) => e.source === "cinema" || e.source === "upcoming");
    if (filter === "library") return evs.filter((e) => e.source === "library-movie" || e.source === "library-series");
    return evs;
  }, [data, filter]);

  const monthPrefix = `${navYear}-${String(navMonth + 1).padStart(2, "0")}`;
  const monthEvents = useMemo(() => filtered.filter((e) => e.date.startsWith(monthPrefix)), [filtered, monthPrefix]);

  const eventsByDate = useMemo(() => {
    const map = new Map<string, CalendarEvent[]>();
    for (const ev of monthEvents) {
      const arr = map.get(ev.date) ?? [];
      arr.push(ev);
      map.set(ev.date, arr);
    }
    return map;
  }, [monthEvents]);

  function prevMonth() {
    selectEvent(null);
    if (navMonth === 0) { setNavMonth(11); setNavYear(y => y - 1); } else setNavMonth(m => m - 1);
  }
  function nextMonth() {
    selectEvent(null);
    if (navMonth === 11) { setNavMonth(0); setNavYear(y => y + 1); } else setNavMonth(m => m + 1);
  }
  function goToday() {
    const now = new Date();
    setNavYear(now.getFullYear());
    setNavMonth(now.getMonth());
    selectEvent(null);
  }

  const monthLabel = new Date(navYear, navMonth, 1).toLocaleDateString(dateLocale, { month: "long", year: "numeric" });

  const FILTERS: { key: FilterMode; label: string; icon: React.ReactNode }[] = [
    { key: "all",     label: t('calendar.filters.all'),     icon: <CalendarDays size={11} /> },
    { key: "cinema",  label: t('calendar.filters.cinema'),  icon: <Clapperboard size={11} /> },
    { key: "library", label: t('calendar.filters.library'), icon: <Film size={11} /> },
  ];

  return (
    <div>
      <PageHeader title={t('calendar.pageTitle')} subtitle={t('calendar.subtitle')} />

      {/* Controls row */}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1">
          <button onClick={prevMonth} className="rounded-lg border border-white/10 p-1.5 text-slate-400 hover:text-white hover:border-white/20 transition-colors">
            <ChevronLeft size={14} />
          </button>
          <span className="min-w-[130px] text-center text-sm font-semibold text-white capitalize">{monthLabel}</span>
          <button onClick={nextMonth} className="rounded-lg border border-white/10 p-1.5 text-slate-400 hover:text-white hover:border-white/20 transition-colors">
            <ChevronRight size={14} />
          </button>
        </div>
        <button onClick={goToday} className="btn btn-ghost btn-sm">
          {t('calendar.today')}
        </button>
        <div className="ml-auto flex items-center gap-1">
          <div className="flex rounded-lg border border-white/10 overflow-hidden">
            {([["month", <CalendarDays size={13} key="m" />], ["list", <LayoutList size={13} key="l" />]] as [ViewMode, React.ReactNode][]).map(([v, icon]) => (
              <button key={v} onClick={() => { setView(v); setSelectedEvent(null); }}
                className={`flex items-center gap-1.5 px-2.5 py-1.5 text-xs transition-colors ${view === v ? "bg-accent-600/20 text-accent-400" : "text-slate-500 hover:text-slate-300"}`}>
                {icon}{v === "month" ? t('calendar.viewMonth') : t('calendar.viewList')}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Filters + legend */}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        {FILTERS.map(({ key, label, icon }) => (
          <button key={key} onClick={() => setFilter(key)}
            className={`flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs font-medium transition-colors ${
              filter === key ? "border-accent-500/40 bg-accent-500/10 text-accent-400" : "border-white/10 text-slate-500 hover:text-slate-300"
            }`}>
            {icon}{label}
          </button>
        ))}
        <div className="ml-auto flex items-center gap-3">
          {(Object.entries(SOURCE_STYLE) as [CalendarEvent["source"], typeof SOURCE_STYLE["cinema"]][]).map(([src, s]) => (
            <div key={src} className="flex items-center gap-1 text-[10px] text-slate-500">
              <span className={`h-2 w-2 rounded-full ${s.dot}`} />{t(s.labelKey)}
            </div>
          ))}
        </div>
      </div>

      {isLoading && <LoadingState label={t('calendar.loading')} />}

      {!isLoading && view === "month" && (
        <MonthGrid
          year={navYear} month={navMonth}
          eventsByDate={eventsByDate} today={today}
          selectedEvent={selectedEvent} onSelectEvent={selectEvent}
          detailRef={detailRef}
        />
      )}
      {!isLoading && view === "list" && (
        monthEvents.length === 0
          ? <p className="py-12 text-center text-sm text-slate-500">{t('calendar.empty')}</p>
          : <ListView events={monthEvents} today={today} dateLocale={dateLocale} />
      )}
    </div>
  );
}
