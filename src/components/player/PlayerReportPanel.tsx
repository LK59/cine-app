"use client";

import useSWR from "swr";
import { PlayerPanelFrame } from "./PlayerPanelFrame";
import { useT } from "@/components/TranslationProvider";
import { LoadingState, ErrorState } from "@/components/StateViews";
import { fetcher } from "@/lib/swr";
import type { ReportDetail } from "@/lib/reports";
import { ReportWizard } from "@/components/reports/ReportWizard";
import { MyReports } from "@/components/reports/MyReports";
import { ReportThread, reportKey } from "@/components/reports/ReportThread";

type ReportView = { kind: "new" } | { kind: "list" } | { kind: "draft"; id: number } | { kind: "thread"; id: number };

/** `#signalement=nouveau | liste | brouillon:<id> | <id>`. */
export function decodeReportView(raw: string): ReportView {
  if (raw === "nouveau") return { kind: "new" };
  if (raw.startsWith("brouillon:")) {
    const id = Number(raw.slice(10));
    if (Number.isInteger(id) && id > 0) return { kind: "draft", id };
  }
  const id = Number(raw);
  if (Number.isInteger(id) && id > 0) return { kind: "thread", id };
  return { kind: "list" };
}

/** Reprendre un brouillon : l'assistant, rempli de ce qu'il contenait. */
function DraftEditor({ id }: { id: number }) {
  const t = useT();
  const { data, error, isLoading, mutate } = useSWR<ReportDetail>(reportKey(id), fetcher);
  if (isLoading) return <LoadingState />;
  if (error || !data) return <ErrorState message={t("report.ui.loadError")} onRetry={() => mutate()} />;
  return <ReportWizard existing={data} />;
}

/**
 * « Signaler un problème » — pour tout le monde, depuis le panneau Compte. Chaque vue (l'assistant,
 * la liste, un ticket) est une entrée d'historique : la coquille le monte sous une clé par vue.
 */
export function PlayerReportPanel({ raw, leaving }: { raw: string; leaving?: boolean }) {
  const t = useT();
  const view = decodeReportView(raw);
  const title =
    view.kind === "new" ? t("report.ui.newTitle") : view.kind === "draft" ? t("report.ui.draftTitle") : view.kind === "list" ? t("report.ui.listTitle") : t("report.ui.threadTitle");
  return (
    <PlayerPanelFrame title={title} back leaving={leaving}>
      {view.kind === "new" && <ReportWizard />}
      {view.kind === "draft" && <DraftEditor id={view.id} />}
      {view.kind === "list" && <MyReports />}
      {view.kind === "thread" && <ReportThread id={view.id} />}
    </PlayerPanelFrame>
  );
}
