"use client";

import useSWR from "swr";
import { BookCheck, BookOpen, Clock, ListTree, RefreshCw, Users } from "lucide-react";
import { fetcher, playerBootstrapOptions } from "@/lib/swr";
import { useT } from "@/components/TranslationProvider";
import { LoadingState, ErrorState } from "@/components/StateViews";
import { Avatar, Panel, Tile, ago, fullDate, hours } from "@/components/activity/parts";
import { ActivityLink } from "@/components/activity/nav";
import type { ReadingAccount, ReadingBook, ReadingsOverview } from "@/lib/activity/readings";

export const READINGS_ADMIN_KEY = "/api/admin/activity/books";

/**
 * Les livres sont-ils allumés sur l'installation ? La même clé que le réglage « Afficher les livres » du
 * Compte (`booksAvailable`), lue sans rien charger des livres : éteints, ni carte ni vue ni requête.
 */
export function useBooksAvailable(): boolean {
  const { data } = useSWR<{ booksAvailable?: boolean }>("/api/config/public", fetcher, playerBootstrapOptions);
  return data?.booksAvailable === true;
}

/** Les trois chiffres de la maison sur sept jours — partagés par la vue d'ensemble et la vue dédiée. */
export function ReadingsTiles({ data }: { data: ReadingsOverview }) {
  const t = useT();
  const readers = data.accounts.filter((a) => a.week.sessions > 0).length;
  const ms = data.accounts.reduce((sum, a) => sum + a.week.ms, 0);
  const sessions = data.accounts.reduce((sum, a) => sum + a.week.sessions, 0);
  const reading = data.accounts.reduce((sum, a) => sum + a.inProgress.length, 0);
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
      <Tile icon={Users} label={t("activity.readings.readers")} value={readers} />
      <Tile icon={Clock} label={t("activity.readings.time7")} value={hours(ms / 1000)} />
      <Tile icon={ListTree} label={t("activity.readings.sessions7")} value={sessions} />
      <Tile icon={BookOpen} label={t("activity.readings.inProgress")} value={reading} />
    </div>
  );
}

function BookLine({ b, now, finished }: { b: ReadingBook; now: number; finished?: boolean }) {
  const t = useT();
  const pct = Math.round(b.fraction * 100);
  return (
    <li className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 py-1.5 text-sm" data-testid="reading-book">
      <span className="min-w-0 flex-1 truncate">
        <span className="text-white">{b.title ?? t("activity.readings.unknownBook")}</span>
        {b.author && <span className="text-subtle"> · {b.author}</span>}
      </span>
      <span className="shrink-0 text-xs tabular-nums text-muted">
        {finished ? fullDate(b.at) : `${pct} % · ${ago(b.at, now, t)}`}
        {b.device && <span className="text-subtle"> · {b.device}</span>}
      </span>
    </li>
  );
}

function AccountReadings({ a, now }: { a: ReadingAccount; now: number }) {
  const t = useT();
  return (
    <div className="space-y-3 px-4 py-4" data-testid="reading-account">
      <div className="flex flex-wrap items-center gap-3">
        <Avatar name={a.account} size={32} />
        <span className="font-medium text-white">{a.account}</span>
        <span className="text-xs text-muted">
          {t("activity.readings.week", { time: hours(a.week.ms / 1000), n: a.week.sessions })} · {t("activity.readings.month", { time: hours(a.month.ms / 1000), n: a.month.sessions })}
        </span>
        {a.lastReadAt && <span className="text-xs text-subtle">{t("activity.readings.lastRead", { when: ago(a.lastReadAt, now, t) })}</span>}
      </div>
      {a.inProgress.length > 0 && (
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-subtle">{t("activity.readings.inProgress")}</p>
          <ul className="divide-y divide-white/5">
            {a.inProgress.map((b) => (
              <BookLine key={b.id} b={b} now={now} />
            ))}
          </ul>
        </div>
      )}
      {a.finished.length > 0 && (
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-subtle">{t("activity.readings.finished")}</p>
          <ul className="divide-y divide-white/5">
            {a.finished.map((b) => (
              <BookLine key={b.id} b={b} now={now} finished />
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/**
 * « Lectures » (DECISIONS.md §129) : par compte, les livres en cours (où il en est, quand, sur quel
 * appareil), les livres terminés et quand, le temps de lecture et le nombre de séances sur sept et trente
 * jours ; puis le fil des dernières lectures. Depuis `book_progress` et `lectures.log`
 * (`readingsOverview`). L'administrateur seul — la route le refuse à tout autre compte.
 */
export function ActivityReadings() {
  const t = useT();
  const { data, isLoading, mutate } = useSWR<ReadingsOverview>(READINGS_ADMIN_KEY, fetcher, { refreshInterval: 60_000 });
  if (isLoading && !data) return <LoadingState />;
  if (!data) return <ErrorState message={t("activity.loadError")} onRetry={() => mutate()} />;
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-2xl text-sm text-muted">{t("activity.readings.intro")}</p>
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" onClick={() => mutate()} className="btn-ghost px-3 py-1.5 text-xs">
            <RefreshCw size={14} />
            <span className="hidden sm:inline">{t("activity.refresh")}</span>
          </button>
          <ActivityLink to={{ kind: "logs", preset: { source: "readings" } }} className="btn-ghost px-3 py-1.5 text-xs">
            <ListTree size={14} />
            <span className="hidden sm:inline">{t("activity.logs.open")}</span>
          </ActivityLink>
        </div>
      </div>

      <ReadingsTiles data={data} />

      <Panel title={t("activity.readings.accounts", { n: data.accounts.length })} icon={Users}>
        {data.accounts.length ? (
          <div className="divide-y divide-white/5">
            {data.accounts.map((a) => (
              <AccountReadings key={a.account} a={a} now={data.now} />
            ))}
          </div>
        ) : (
          <p className="px-4 py-6 text-sm text-subtle">{t("activity.readings.none")}</p>
        )}
      </Panel>

      <Panel title={t("activity.readings.recent")} icon={BookCheck}>
        {data.recent.length ? (
          <ul className="scrollbar-thin max-h-[32rem] divide-y divide-white/5 overflow-y-auto">
            {data.recent.map((e, i) => (
              <li key={`${e.at}:${i}`} className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 px-4 py-2 text-sm sm:grid-cols-[8.5rem_7rem_1fr]" data-testid="reading-event">
                <span className="text-xs tabular-nums text-subtle">{fullDate(e.at)}</span>
                <span className="truncate text-xs text-muted">{e.account}</span>
                <span className="col-span-2 min-w-0 break-words text-white sm:col-span-1">
                  {e.kind === "terminé"
                    ? t("activity.readings.eventFinished", { title: e.title ?? t("activity.readings.unknownBook") })
                    : e.kind === "retiré"
                      ? t("activity.readings.eventRemoved", { title: e.title ?? t("activity.readings.unknownBook") })
                      : e.kind === "marqué lu"
                        ? t("activity.readings.eventMarkedRead", { title: e.title ?? t("activity.readings.unknownBook") })
                        : e.kind === "marqué non lu"
                          ? t("activity.readings.eventMarkedUnread", { title: e.title ?? t("activity.readings.unknownBook") })
                          : t("activity.readings.eventSession", { title: e.title ?? t("activity.readings.unknownBook"), time: hours((e.durationMs ?? 0) / 1000) })}
                  {(e.device || e.offline) && (
                    <span className="text-subtle">
                      {" "}
                      · {[e.device, e.offline ? t("activity.readings.offline") : null].filter(Boolean).join(" · ")}
                    </span>
                  )}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="px-4 py-6 text-sm text-subtle">{t("activity.readings.noRecent")}</p>
        )}
      </Panel>
    </div>
  );
}
