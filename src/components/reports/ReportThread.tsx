"use client";

import { useState } from "react";
import useSWR, { useSWRConfig } from "swr";
import { CheckCircle2, Clapperboard, ExternalLink, KeyRound, Bell, Pencil, RotateCcw, Send, ServerCrash, Smartphone, XCircle } from "lucide-react";
import { fetcher } from "@/lib/swr";
import { apiAction } from "@/lib/apiAction";
import { cinemaNavigate } from "@/lib/cinemaRoute";
import { useT } from "@/components/TranslationProvider";
import { useToast } from "@/components/Toast";
import { LoadingState, ErrorState } from "@/components/StateViews";
import { Panel, SeanceRow, JsonBlock, describeLine, fullDate, kindDot } from "@/components/activity/parts";
import type { ReportStatus } from "@/lib/db";
import type { ReportDetail, ImageView } from "@/lib/reports";
import type { ReportLogs } from "@/lib/reportLogs";
import { REPORTS_UNREAD_KEY } from "@/lib/useReportBadge";
import { ImagePicker } from "./ImagePicker";
import { appendImages } from "./prepareImage";
import { ReportPath, StatusBadge } from "./ReportParts";

export const reportKey = (id: number | string) => `/api/reports/${id}`;

/** Les captures d'un message : la version montrée, ou l'original quand rien n'a pu la produire. */
function Images({ images }: { images: ImageView[] }) {
  const t = useT();
  if (!images.length) return null;
  return (
    <div className="mt-2 flex flex-wrap gap-2">
      {images.map((image) =>
        image.url ? (
          <a key={image.id} href={image.originalUrl} target="_blank" rel="noreferrer" className="block overflow-hidden rounded-lg border border-white/10">
            {/* eslint-disable-next-line @next/next/no-img-element -- servie par notre route, déjà réduite */}
            <img src={image.url} alt={image.name ?? ""} loading="lazy" className="h-28 max-w-[14rem] object-cover" />
          </a>
        ) : (
          <a
            key={image.id}
            href={image.originalUrl}
            target="_blank"
            rel="noreferrer"
            className="flex h-28 w-28 flex-col items-center justify-center gap-1 rounded-lg border border-white/10 bg-white/5 p-2 text-center text-[11px] text-muted"
          >
            <ExternalLink size={14} />
            {t("report.ui.noPreview")}
            <span className="w-full truncate text-subtle">{image.name}</span>
          </a>
        )
      )}
    </div>
  );
}

/** Ce que le ticket a emporté des journaux — pour l'administrateur seul. */
function LogsSnapshot({ logs }: { logs: ReportLogs }) {
  const t = useT();
  const now = logs.capturedAt;
  const lines = (title: string, icon: React.ElementType, list: Record<string, unknown>[]) =>
    list.length > 0 && (
      <Panel title={`${title} (${list.length})`} icon={icon}>
        <ul className="divide-y divide-white/5">
          {[...list].reverse().map((line, i) => (
            <li key={i} className="px-4 py-2 text-xs">
              <details>
                <summary className="flex cursor-pointer list-none items-center gap-2">
                  <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${kindDot(String(line.kind ?? line.scope ?? ""))}`} />
                  <span className="shrink-0 tabular-nums text-subtle">{fullDate(Number(line.at))}</span>
                  <span className="min-w-0 truncate text-slate-300">{describeLine(line, t)}</span>
                </summary>
                <div className="mt-2">
                  <JsonBlock value={line} />
                </div>
              </details>
            </li>
          ))}
        </ul>
      </Panel>
    );
  return (
    <div className="space-y-4">
      <p className="text-xs text-subtle">{t("report.ui.logsCaptured", { when: fullDate(logs.capturedAt) })}</p>
      {logs.itemSeances.length > 0 && (
        <Panel title={t("report.ui.logsItem")} icon={Clapperboard}>
          <div className="divide-y divide-white/5">
            {logs.itemSeances.map((s) => (
              <SeanceRow key={s.id} s={s} now={now} />
            ))}
          </div>
        </Panel>
      )}
      <Panel title={t("report.ui.logsRecent")} icon={Clapperboard}>
        {logs.seances.length ? (
          <div className="divide-y divide-white/5">
            {logs.seances.map((s) => (
              <SeanceRow key={s.id} s={s} now={now} />
            ))}
          </div>
        ) : (
          <p className="px-4 py-4 text-sm text-subtle">{t("report.ui.logsNone")}</p>
        )}
      </Panel>
      {lines(t("report.ui.logsErrors"), ServerCrash, logs.errors)}
      {lines(t("report.ui.logsAuth"), KeyRound, logs.auth)}
      {lines(t("report.ui.logsNotifications"), Bell, logs.notifications)}
    </div>
  );
}

const ADMIN_CHOICES: ReportStatus[] = ["open", "in_progress", "resolved", "closed"];

/**
 * Un signalement : ce qui a été dit, les échanges, et de quoi répondre. Le même écran des deux
 * côtés — l'auteur ferme et rouvre le sien ; l'administrateur choisit l'état, et voit en plus le
 * contexte de l'appareil et les journaux figés à l'envoi.
 */
export function ReportThread({ id }: { id: number }) {
  const t = useT();
  const toast = useToast();
  const { mutate: mutateGlobal } = useSWRConfig();
  const { data, error, isLoading, mutate } = useSWR<ReportDetail>(reportKey(id), fetcher, {
    // L'ouverture marque le ticket lu : la pastille doit l'apprendre tout de suite.
    onSuccess: () => void mutateGlobal(REPORTS_UNREAD_KEY),
  });
  const [body, setBody] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);

  if (isLoading) return <LoadingState />;
  if (error || !data) return <ErrorState message={error instanceof Error ? error.message : t("report.ui.loadError")} onRetry={() => mutate()} />;
  const r = data;
  const admin = r.logs !== undefined || r.context !== undefined;

  const act = async (run: () => Promise<unknown>) => {
    setBusy(true);
    try {
      const next = (await run()) as ReportDetail;
      await mutate(next, { revalidate: false });
      void mutateGlobal((key) => typeof key === "string" && (key === "/api/reports" || key === "/api/admin/activity/reports"));
      return true;
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t("report.ui.failed"));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const setStatus = (status: ReportStatus) =>
    act(() => apiAction(`/api/reports/${r.id}/status`, { method: "POST", body: JSON.stringify({ status }), headers: { "Content-Type": "application/json" } }));

  const send = async () => {
    const form = new FormData();
    form.set("body", body);
    await appendImages(form, files);
    if (await act(() => apiAction(`/api/reports/${r.id}/messages`, { method: "POST", body: form }))) {
      setBody("");
      setFiles([]);
    }
  };

  if (r.status === "draft") {
    return (
      <div className="mx-auto max-w-xl space-y-4 pt-2">
        <ReportPath report={r} wrap className="text-base font-semibold text-white" />
        <p className="text-sm text-muted">{t("report.ui.draftHint")}</p>
        <button type="button" onClick={() => cinemaNavigate({ report: `brouillon:${r.id}` }, "replace")} className="btn btn-primary px-4 py-2 text-sm">
          <Pencil size={15} />
          {t("report.ui.editDraft")}
        </button>
      </div>
    );
  }

  const topImages = r.images.filter((i) => i.messageId === null);
  const closed = r.status === "closed" || r.status === "resolved";

  return (
    <div className={`mx-auto w-full space-y-5 pt-2 ${admin ? "max-w-5xl" : "max-w-2xl"}`}>
      {/* L'en-tête : l'état, le chemin, qui et quand. */}
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge status={r.status} />
          <span className="text-xs text-subtle">#{r.id}</span>
        </div>
        <ReportPath report={r} wrap className="text-lg font-semibold text-white" />
        <p className="text-xs text-muted">
          {[r.itemTitle, admin ? r.userName : null, t("report.ui.sentOn", { when: fullDate(r.sentAt) })].filter(Boolean).join(" · ")}
        </p>
      </div>

      {/* Les actions sur l'état. */}
      <div className="flex flex-wrap gap-2">
        {admin
          ? ADMIN_CHOICES.map((s) => (
              <button
                key={s}
                type="button"
                disabled={busy || r.status === s}
                onClick={() => setStatus(s)}
                className={`rounded-full border px-3 py-1.5 text-xs transition-colors ${
                  r.status === s ? "border-accent-500/60 bg-accent-500/15 text-white" : "border-white/10 text-muted hover:text-white"
                }`}
              >
                {t(`report.status.${s}`)}
              </button>
            ))
          : r.mine &&
            (closed ? (
              <button type="button" disabled={busy} onClick={() => setStatus("open")} className="btn btn-ghost px-3 py-2 text-sm">
                <RotateCcw size={15} />
                {t("report.ui.reopen")}
              </button>
            ) : (
              <button type="button" disabled={busy} onClick={() => setStatus("closed")} className="btn btn-ghost px-3 py-2 text-sm">
                <XCircle size={15} />
                {t("report.ui.close")}
              </button>
            ))}
      </div>

      {/* `minmax(0, 1fr)` aussi sur téléphone : une colonne automatique prenait la largeur du JSON du
          contexte, et tout le ticket débordait de l'écran. */}
      <div className={admin ? "grid grid-cols-[minmax(0,1fr)] gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]" : ""}>
        <div className="space-y-4">
          {/* Le signalement lui-même, puis les échanges, dans l'ordre. */}
          <div className="rounded-xl border border-white/10 bg-white/5 p-4">
            <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-slate-100">{r.description}</p>
            <Images images={topImages} />
          </div>
          <ol className="space-y-3">
            {r.messages.map((m) => {
              if (m.author === "system") {
                const status = m.body.startsWith("status:") ? m.body.slice(7) : null;
                return (
                  <li key={m.id} className="flex items-center justify-center gap-2 text-center text-xs text-subtle">
                    <CheckCircle2 size={12} />
                    {status ? t("report.ui.statusChanged", { who: m.authorName, status: t(`report.status.${status}`) }) : m.body}
                    <span>· {fullDate(m.createdAt)}</span>
                  </li>
                );
              }
              const fromAdmin = m.author === "admin";
              const own = admin ? fromAdmin : !fromAdmin;
              return (
                <li key={m.id} className={`flex ${own ? "justify-end" : "justify-start"}`}>
                  <div className={`max-w-[85%] rounded-2xl px-4 py-2.5 ${own ? "bg-accent-500/20" : "bg-white/10"}`}>
                    <p className="mb-0.5 text-[11px] text-muted">
                      {fromAdmin ? t("report.ui.fromAdmin") : m.authorName} · {fullDate(m.createdAt)}
                    </p>
                    {m.body && <p className="whitespace-pre-wrap break-words text-sm text-slate-100">{m.body}</p>}
                    <Images images={r.images.filter((i) => i.messageId === m.id)} />
                  </div>
                </li>
              );
            })}
          </ol>

          {/* Répondre : des mots, des captures, ou les deux. */}
          <div className="space-y-2 rounded-xl border border-white/10 p-3">
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              maxLength={5000}
              rows={3}
              placeholder={admin ? t("report.ui.replyPlaceholderAdmin") : t("report.ui.replyPlaceholder")}
              className="input w-full resize-y py-2 text-sm"
            />
            <div className="flex flex-wrap items-end justify-between gap-2">
              <ImagePicker files={files} onChange={setFiles} />
              <button type="button" disabled={busy || (!body.trim() && files.length === 0)} onClick={send} className="btn btn-primary px-4 py-2 text-sm">
                <Send size={15} />
                {t("report.ui.reply")}
              </button>
            </div>
          </div>
        </div>

        {admin && (
          <div className="mt-6 space-y-4 lg:mt-0">
            {r.context && (
              <Panel title={t("report.ui.context")} icon={Smartphone}>
                <div className="p-3">
                  <JsonBlock value={r.context} />
                </div>
              </Panel>
            )}
            {r.logs ? <LogsSnapshot logs={r.logs as unknown as ReportLogs} /> : <p className="text-sm text-subtle">{t("report.ui.logsNone")}</p>}
          </div>
        )}
      </div>
    </div>
  );
}
