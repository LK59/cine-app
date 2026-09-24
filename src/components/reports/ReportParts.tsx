"use client";

import { Lightbulb } from "lucide-react";
import { useT } from "@/components/TranslationProvider";
import { reportPathParts } from "@/lib/reportTaxonomy";
import type { ReportStatus } from "@/lib/db";
import type { ReportSummary } from "@/lib/reports";

const STATUS_TONE: Record<ReportStatus, string> = {
  draft: "bg-white/10 text-muted",
  open: "bg-sky-500/15 text-sky-300",
  in_progress: "bg-amber-500/15 text-amber-300",
  resolved: "bg-emerald-500/15 text-emerald-300",
  closed: "bg-white/10 text-subtle",
};

export function StatusBadge({ status }: { status: ReportStatus }) {
  const t = useT();
  return <span className={`inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[11px] font-medium ${STATUS_TONE[status]}`}>{t(`report.status.${status}`)}</span>;
}

/** Le chemin choisi, en mots : « Lecteur › Son › Décalé avec l'image ». */
export function ReportPath({
  report,
  className = "",
  wrap = false,
}: {
  report: Pick<ReportSummary, "zone" | "element" | "elementOther" | "issue" | "issueOther" | "suggestion">;
  className?: string;
  /** En titre, le chemin entier passe à la ligne ; dans une liste, il se coupe. */
  wrap?: boolean;
}) {
  const t = useT();
  const parts = reportPathParts(report, (key) => t(key));
  return (
    <span className={`inline-flex min-w-0 items-center gap-1.5 ${className}`}>
      {report.suggestion && <Lightbulb size={13} className="shrink-0 text-amber-300" />}
      <span className={wrap ? "break-words" : "truncate"}>{parts.join(" › ")}</span>
    </span>
  );
}

/** Une ligne de liste : l'état, le chemin, le titre, l'extrait — et la pastille du nouveau. */
export function ReportRowView({ r, showUser = false, onOpen, when }: { r: ReportSummary; showUser?: boolean; onOpen: () => void; when: string }) {
  const t = useT();
  return (
    <button type="button" onClick={onOpen} className="flex w-full items-start gap-3 px-4 py-3 text-left transition-colors hover:bg-white/[0.04]">
      <span className="min-w-0 flex-1 space-y-1">
        <span className="flex items-center gap-2">
          <StatusBadge status={r.status} />
          <ReportPath report={r} className="text-sm font-medium text-white" />
        </span>
        {(r.itemTitle || showUser) && (
          <span className="block truncate text-xs text-muted">
            {[showUser ? r.userName : null, r.itemTitle].filter(Boolean).join(" · ")}
          </span>
        )}
        {r.excerpt ? <span className="line-clamp-2 block text-xs text-subtle">{r.excerpt}</span> : <span className="block text-xs italic text-subtle">{t("report.ui.noDescription")}</span>}
      </span>
      <span className="flex shrink-0 flex-col items-end gap-1.5">
        <span className="text-[11px] text-subtle">{when}</span>
        {r.unread && <span className="h-2 w-2 rounded-full bg-accent-500" aria-label={t("report.ui.unread")} />}
      </span>
    </button>
  );
}
