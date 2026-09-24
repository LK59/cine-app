"use client";

import Link from "next/link";
import { use, useState } from "react";
import useSWR from "swr";
import { ArrowLeft, AudioLines, ChevronDown, ChevronRight, Clock, FastForward, Hourglass, ListTree, Moon, Wrench } from "lucide-react";
import { fetcher } from "@/lib/swr";
import { LoadingState, ErrorState } from "@/components/StateViews";
import { useT } from "@/components/TranslationProvider";
import { JsonBlock, Poster, SeanceFlags, Steps, Tile, clock, describeLine, fullDate, hours, kindDot, kindTone, secs } from "@/components/activity/parts";
import type { Seance } from "@/lib/activity/seances";

interface SeanceData {
  seance: Seance;
  lines: Record<string, unknown>[];
}

/** Une étape de la séance : l'instant depuis l'ouverture, ce qui s'est passé, et le détail à la demande. */
function Step({ line, start }: { line: Record<string, unknown>; start: number }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const at = Date.parse(String(line.timestamp ?? "")) || start;
  const kind = String(line.kind ?? "?");
  const { steps, ...rest } = line as { steps?: unknown };
  return (
    <li className="relative pl-8">
      <span className={`absolute left-[7px] top-3 h-2.5 w-2.5 rounded-full ring-4 ring-slate-950 ${kindDot(kind)}`} />
      <button type="button" onClick={() => setOpen((v) => !v)} className="flex w-full items-start gap-3 py-2 text-left">
        <span className="w-16 shrink-0 font-mono text-[11px] text-slate-500">+{clock((at - start) / 1000)}</span>
        <span className={`w-16 shrink-0 rounded px-1.5 py-0.5 text-center font-mono text-[10px] ${kindTone(kind)}`}>{kind}</span>
        <span className="min-w-0 flex-1 break-words text-sm text-slate-200">{describeLine(line, t)}</span>
        {open ? <ChevronDown size={14} className="mt-0.5 shrink-0 text-slate-500" /> : <ChevronRight size={14} className="mt-0.5 shrink-0 text-slate-500" />}
      </button>
      {open && (
        <div className="space-y-2 pb-3 pl-[76px]">
          {typeof steps === "string" && <Steps text={steps} />}
          <JsonBlock value={rest} />
        </div>
      )}
    </li>
  );
}

export default function SeancePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const t = useT();
  const { data, error, isLoading, mutate } = useSWR<SeanceData>(`/api/admin/activity/seances/${encodeURIComponent(id)}`, fetcher);

  if (isLoading && !data) return <LoadingState />;
  if (error || !data) return <ErrorState message={t("activity.loadError")} onRetry={() => mutate()} />;

  const { seance: s, lines } = data;
  const stop = s.stop;

  return (
    <div className="space-y-6">
      <Link href="/activite" className="inline-flex items-center gap-1.5 text-sm text-slate-400 hover:text-white">
        <ArrowLeft size={15} />
        {t("activity.title")}
      </Link>

      <div className="flex items-start gap-4">
        <Poster itemId={s.itemId} className="h-24 w-16" />
        <div className="min-w-0 flex-1">
          <h1 className="text-xl font-semibold text-white">{s.title}</h1>
          <p className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-sm text-slate-400">
            <span className="text-accent-300">{s.user}</span>
            <span>{fullDate(s.start)}</span>
            {s.device && <span>{s.device}</span>}
            <span>{s.player === "serveur" ? t("activity.seance.serverPlayer") : t("activity.seance.nativePlayer", { path: s.path ?? "?" })}</span>
          </p>
          <p className="mt-1 flex flex-wrap gap-x-3 text-xs text-slate-500">
            {s.container && <span>{s.container}</span>}
            {s.video && <span>{s.video}</span>}
            {s.range && <span>{s.range}</span>}
          </p>
          <div className="mt-2">
            <SeanceFlags s={s} />
          </div>
        </div>
        <Link href={`/activite/journaux?source=player&session=${encodeURIComponent(s.id)}&days=0`} className="btn-ghost shrink-0 px-3 py-1.5 text-xs">
          <ListTree size={14} />
          {t("activity.logs.title")}
        </Link>
      </div>

      {stop ? (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
          <Tile icon={Clock} label={t("activity.seance.watchedLabel")} value={hours(stop.watched)} hint={t("activity.seance.endedAt", { at: clock(stop.at), why: stop.why ?? "?" })} />
          <Tile icon={Hourglass} label={t("activity.week.waits")} value={stop.waits} hint={t("activity.seance.waitsHint", { d: secs(stop.waitedMs), max: secs(stop.longestWaitMs) })} tone={stop.waits > 3 ? "warn" : "default"} />
          <Tile icon={FastForward} label={t("activity.seance.seeks")} value={s.seeks} hint={t("activity.seance.seekWait", { d: secs(stop.seekWaitMs) })} tone={s.slowSeeks ? "warn" : "default"} />
          <Tile icon={AudioLines} label={t("activity.seance.audio")} value={s.audioSwitches} />
          <Tile icon={Moon} label={t("activity.seance.backgrounds")} value={stop.backgrounds} hint={hours(stop.backgroundMs / 1000)} />
          <Tile icon={Wrench} label={t("activity.seance.incidents")} value={s.rebuilds + s.stalls + s.fallbacks + s.errors} tone={s.rebuilds + s.stalls + s.fallbacks + s.errors ? "warn" : "good"} />
        </div>
      ) : (
        <p className="card px-4 py-3 text-sm text-slate-400">{s.legacy ? t("activity.seance.legacyHint") : t("activity.seance.noStop")}</p>
      )}

      <section className="card p-4">
        <h2 className="mb-2 text-sm font-semibold text-white">{t("activity.seance.timeline", { n: lines.length })}</h2>
        <ol className="relative before:absolute before:bottom-2 before:left-[11px] before:top-2 before:w-px before:bg-white/10">
          {lines.map((line, i) => (
            <Step key={i} line={line} start={s.start} />
          ))}
        </ol>
      </section>
    </div>
  );
}
