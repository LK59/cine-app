"use client";

import { useState } from "react";
import { Modal } from "@/components/Modal";
import { Pause, Play, Trash2, ArrowDown, ArrowUp } from "lucide-react";
import type { QbTorrent } from "@/lib/clients/qbittorrent";
import { fmtSize, fmtEta, relativeTimeAbs } from "@/lib/format";
import { useT } from "@/components/TranslationProvider";

function isPaused(state: string): boolean {
  return /^(paused|stopped)/i.test(state);
}

export function TorrentDetailModal({
  torrent,
  isReadOnly,
  onClose,
  onAction,
  onRemove,
}: {
  torrent: QbTorrent;
  isReadOnly: boolean;
  onClose: () => void;
  onAction: (hash: string, action: "pause" | "resume") => void;
  onRemove: (hash: string, deleteFiles: boolean) => void;
}) {
  const t = useT();
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleteFiles, setDeleteFiles] = useState(false);

  return (
    <Modal title={torrent.name} onClose={onClose} wide>
      <div className="space-y-4">
        <div>
          <p className="text-xs text-slate-500">{t("qbittorrent.detail.fullName")}</p>
          <p className="break-words text-sm text-slate-200">{torrent.name}</p>
        </div>

        {torrent.content_path && (
          <div>
            <p className="text-xs text-slate-500">{t("qbittorrent.detail.path")}</p>
            <p className="break-all text-xs text-slate-400">{torrent.content_path}</p>
          </div>
        )}

        <div className="h-1.5 w-full rounded-full bg-slate-800">
          <div
            className="h-1.5 rounded-full bg-accent-500"
            style={{ width: `${Math.round(torrent.progress * 100)}%` }}
          />
        </div>

        <div className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-3">
          <div>
            <p className="text-xs text-slate-500">{t("qbittorrent.detail.status")}</p>
            <p className="capitalize text-slate-200">{torrent.state}</p>
          </div>
          <div>
            <p className="text-xs text-slate-500">{t("qbittorrent.detail.size")}</p>
            <p className="text-slate-200">{fmtSize(torrent.size)}</p>
          </div>
          <div>
            <p className="text-xs text-slate-500">{t("qbittorrent.eta")}</p>
            <p className="text-slate-200">{fmtEta(torrent.eta)}</p>
          </div>
          <div>
            <p className="text-xs text-slate-500">{t("qbittorrent.detail.down")}</p>
            <p className="flex items-center gap-1 text-emerald-400">
              <ArrowDown size={12} /> {fmtSize(torrent.dlspeed)}/s
            </p>
          </div>
          <div>
            <p className="text-xs text-slate-500">{t("qbittorrent.detail.up")}</p>
            <p className="flex items-center gap-1 text-accent-400">
              <ArrowUp size={12} /> {fmtSize(torrent.upspeed)}/s
            </p>
          </div>
          <div>
            <p className="text-xs text-slate-500">{t("qbittorrent.detail.ratio")}</p>
            <p className="text-slate-200">{torrent.ratio.toFixed(2)}</p>
          </div>
          <div>
            <p className="text-xs text-slate-500">{t("qbittorrent.detail.downloaded")}</p>
            <p className="text-slate-200">{fmtSize(torrent.downloaded)}</p>
          </div>
          <div>
            <p className="text-xs text-slate-500">{t("qbittorrent.detail.uploaded")}</p>
            <p className="text-slate-200">{fmtSize(torrent.uploaded)}</p>
          </div>
          <div>
            <p className="text-xs text-slate-500">{t("qbittorrent.detail.age")}</p>
            <p className="text-slate-200">
              {torrent.added_on ? relativeTimeAbs(torrent.added_on * 1000, t) : "—"}
            </p>
          </div>
        </div>

        {!isReadOnly && (
          <div className="flex flex-col gap-3 border-t border-white/5 pt-4">
            <div className="flex items-center gap-2">
              {isPaused(torrent.state) ? (
                <button onClick={() => onAction(torrent.hash, "resume")} className="btn-ghost">
                  <Play size={14} /> {t("common.resume")}
                </button>
              ) : (
                <button onClick={() => onAction(torrent.hash, "pause")} className="btn-ghost">
                  <Pause size={14} /> {t("qbittorrent.detail.pause")}
                </button>
              )}
              {!confirmingDelete && (
                <button onClick={() => setConfirmingDelete(true)} className="btn-danger">
                  <Trash2 size={14} /> {t("common.delete")}
                </button>
              )}
            </div>

            {confirmingDelete && (
              <div className="rounded-lg border border-red-500/20 bg-red-500/5 p-3">
                <label className="flex items-center gap-2 text-sm text-slate-200">
                  <input
                    type="checkbox"
                    checked={deleteFiles}
                    onChange={(e) => setDeleteFiles(e.target.checked)}
                  />
                  {t("qbittorrent.detail.deleteFilesToo")}
                </label>
                <div className="mt-3 flex items-center gap-2">
                  <button
                    onClick={() => onRemove(torrent.hash, deleteFiles)}
                    className="btn-danger"
                  >
                    {t("qbittorrent.detail.confirmRemove")}
                  </button>
                  <button onClick={() => setConfirmingDelete(false)} className="btn-ghost">
                    {t("common.cancel")}
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}
