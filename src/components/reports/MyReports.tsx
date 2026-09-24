"use client";

import useSWR from "swr";
import { Plus } from "lucide-react";
import { fetcher } from "@/lib/swr";
import { cinemaNavigate } from "@/lib/cinemaRoute";
import { useT } from "@/components/TranslationProvider";
import { LoadingState, ErrorState } from "@/components/StateViews";
import { fullDate } from "@/components/activity/parts";
import type { ReportSummary } from "@/lib/reports";
import { ReportRowView } from "./ReportParts";
import { FRESH, MY_REPORTS_KEY } from "./reportCache";


/** Les signalements d'une personne : ses brouillons, ceux qui sont en cours, ceux qui sont réglés. */
export function MyReports() {
  const t = useT();
  const { data, error, isLoading, mutate } = useSWR<{ reports: ReportSummary[] }>(MY_REPORTS_KEY, fetcher, FRESH);
  if (isLoading) return <LoadingState />;
  if (error || !data) return <ErrorState message={t("report.ui.loadError")} onRetry={() => mutate()} />;

  const groups: { key: string; title: string; list: ReportSummary[] }[] = [
    { key: "drafts", title: t("report.ui.groupDrafts"), list: data.reports.filter((r) => r.status === "draft") },
    { key: "open", title: t("report.ui.groupOpen"), list: data.reports.filter((r) => r.status === "open" || r.status === "in_progress") },
    { key: "done", title: t("report.ui.groupDone"), list: data.reports.filter((r) => r.status === "resolved" || r.status === "closed") },
  ];

  return (
    <div className="mx-auto w-full max-w-2xl space-y-6 pt-2">
      <button type="button" onClick={() => cinemaNavigate({ report: "nouveau" })} className="btn btn-primary w-full justify-center py-3 text-sm sm:w-auto sm:px-5">
        <Plus size={16} />
        {t("report.ui.new")}
      </button>
      {data.reports.length === 0 && <p className="text-sm text-muted">{t("report.ui.empty")}</p>}
      {groups
        .filter((g) => g.list.length > 0)
        .map((g) => (
          <section key={g.key} className="space-y-2">
            <h3 className="px-1 text-xs font-semibold uppercase tracking-wide text-subtle">{g.title}</h3>
            <div className="card divide-y divide-white/5 overflow-hidden">
              {g.list.map((r) => (
                <ReportRowView
                  key={r.id}
                  r={r}
                  when={fullDate(r.status === "draft" ? r.updatedAt : r.sentAt)}
                  onOpen={() => cinemaNavigate({ report: r.status === "draft" ? `brouillon:${r.id}` : String(r.id) })}
                />
              ))}
            </div>
          </section>
        ))}
    </div>
  );
}
