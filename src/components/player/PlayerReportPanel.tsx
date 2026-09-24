"use client";

import useSWR from "swr";
import { PlayerPanelFrame } from "./PlayerPanelFrame";
import { useT } from "@/components/TranslationProvider";
import { LoadingState, ErrorState } from "@/components/StateViews";
import { fetcher } from "@/lib/swr";
import type { ReportDetail } from "@/lib/reports";
import { ReportWizard } from "@/components/reports/ReportWizard";
import { MyReports } from "@/components/reports/MyReports";
import { ReportThread } from "@/components/reports/ReportThread";
import { FRESH, reportKey } from "@/components/reports/reportCache";

type ReportView = { kind: "new"; fromList: boolean } | { kind: "list" } | { kind: "draft"; id: number } | { kind: "thread"; id: number };

/** `#signalement=nouveau | nouveau:liste | liste | brouillon:<id> | <id>` — « :liste » : ouvert depuis la liste. */
export function decodeReportView(raw: string): ReportView {
  if (raw === "nouveau" || raw === "nouveau:liste") return { kind: "new", fromList: raw === "nouveau:liste" };
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
  const { data, error, isLoading, mutate } = useSWR<ReportDetail>(reportKey(id), fetcher, FRESH);
  if (isLoading) return <LoadingState />;
  if (error || !data) return <ErrorState message={t("report.ui.loadError")} onRetry={() => mutate()} />;
  // Déjà parti — depuis un autre appareil, ou une liste restée en retard : c'est le ticket qu'on
  // montre, jamais un assistant dont l'envoi serait refusé.
  if (data.status !== "draft") return <ReportThread id={data.id} />;
  // Un brouillon ne s'ouvre que depuis la liste (ou le ticket qu'elle a ouvert) : il y revient.
  return <ReportWizard key={data.updatedAt} existing={data} fromList />;
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
      {view.kind === "new" && <ReportWizard fromList={view.fromList} />}
      {view.kind === "draft" && <DraftEditor id={view.id} />}
      {view.kind === "list" && <MyReports />}
      {view.kind === "thread" && <ReportThread id={view.id} />}
    </PlayerPanelFrame>
  );
}
