"use client";

import { useEffect, useState } from "react";
import { Download, Film, Play, Trash2, X } from "lucide-react";
import { ActionSheet } from "@/components/ActionSheet";
import { Modal } from "@/components/Modal";
import { useLocale, useT } from "@/components/TranslationProvider";
import { usePlayback } from "@/components/PlaybackProvider";
import { cinemaNavigate } from "@/lib/cinemaRoute";
import { formatFileSize } from "@/lib/format";
import { useOfflineDownloadsEnabled } from "@/lib/offline/useOfflineEnabled";
import { deviceStore, deviceStoreSupported } from "@/lib/offline/deviceStore";
import { initOfflineDownloads, offlineAccount, removeOfflineDownload, useOfflineDownloads, type OfflineDownload } from "@/lib/offline/downloads";
import { BetaBadge, offlineStatusLabel, ProgressRing, offlineProgress } from "./OfflineDownloadControl";

/**
 * Le gestionnaire des téléchargements hors ligne (bêta, 19/10/2026) : un rond à côté de « Tous les
 * films / Toutes les séries » (Louis, pour le dessin), qui ouvre la liste — ouvrir la fiche, la
 * taille, supprimer. C'est aussi lui qui relance les téléchargements en cours à l'ouverture de
 * l'accueil : il y est toujours monté.
 */
export function OfflineDownloadsButton() {
  const t = useT();
  const enabled = useOfflineDownloadsEnabled();
  const [supported] = useState(deviceStoreSupported);
  const downloads = useOfflineDownloads();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!enabled || !supported) return;
    void initOfflineDownloads();
    // Au retour au premier plan : la boucle a pu être suspendue (iPhone en arrière-plan).
    const onVisible = () => {
      if (document.visibilityState === "visible") void initOfflineDownloads();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [enabled, supported]);

  if (!enabled || !supported) return null;
  const active = downloads.find((d) => d.state === "preparing" || d.state === "downloading");
  const label = t("player.downloads.manager");
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={label}
        title={label}
        data-liquid
        className="nav-glass flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-white"
      >
        {active ? <ProgressRing value={offlineProgress(active)} size={17} /> : <Download size={17} aria-hidden />}
      </button>
      {open && <OfflineDownloadsPanel onClose={() => setOpen(false)} />}
    </>
  );
}

function OfflineDownloadsPanel({ onClose }: { onClose: () => void }) {
  const t = useT();
  const { locale } = useLocale();
  const downloads = useOfflineDownloads();
  const used = downloads.reduce((sum, d) => sum + d.bytes, 0);
  return (
    <Modal title={t("player.downloads.manager")} onClose={onClose}>
      <div className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <p className="text-xs text-subtle">{used > 0 ? t("player.downloads.used", { size: formatFileSize(used, locale) }) : ""}</p>
          <BetaBadge />
        </div>
        {downloads.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted">{t("player.downloads.empty")}</p>
        ) : (
          <ul className="space-y-2">
            {downloads.map((d) => (
              <OfflineDownloadRow key={d.id} download={d} onClose={onClose} />
            ))}
          </ul>
        )}
      </div>
    </Modal>
  );
}

function OfflineDownloadRow({ download: d, onClose }: { download: OfflineDownload; onClose: () => void }) {
  const t = useT();
  const { locale } = useLocale();
  const playback = usePlayback();
  const poster = usePosterUrl(d);
  const [confirming, setConfirming] = useState(false);
  const size =
    d.state === "done"
      ? formatFileSize(d.bytes, locale)
      : t("player.downloads.sizeOf", { done: formatFileSize(d.bytes, locale), total: formatFileSize(d.expectedBytes, locale) });
  return (
    <li className="flex items-center gap-3 rounded-2xl bg-white/5 p-2.5">
      {poster ? (
        // Une adresse `blob:` de l'affiche gardée sur l'appareil : rien à optimiser par le serveur.
        // eslint-disable-next-line @next/next/no-img-element
        <img src={poster} alt="" className="h-16 w-11 shrink-0 rounded-lg object-cover" />
      ) : (
        <span className="flex h-16 w-11 shrink-0 items-center justify-center rounded-lg bg-white/10 text-subtle">
          <Film size={18} />
        </span>
      )}
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-white">{d.title}</p>
        <p className="truncate text-xs text-subtle">
          {offlineStatusLabel(d, t)} · {size}
        </p>
        <p className="truncate text-xs text-subtle">
          {t(`player.downloads.${d.quality}`)} · {d.audioLabel}
        </p>
        {d.state === "failed" && d.error && <p className="truncate text-xs text-warning">{d.error}</p>}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {d.state === "done" && (
          <button
            type="button"
            aria-label={t("player.downloads.playDownloaded")}
            title={t("player.downloads.playDownloaded")}
            onClick={() => {
              onClose();
              playback.play({ itemId: d.itemId, title: d.title, resumeAt: d.positionSeconds, offline: { id: d.id } });
            }}
            className="flex h-9 w-9 items-center justify-center rounded-full bg-white text-ink"
          >
            <Play size={15} fill="currentColor" />
          </button>
        )}
        {d.radarrId !== null && (
          <button
            type="button"
            aria-label={t("player.downloads.open")}
            title={t("player.downloads.open")}
            onClick={() => {
              onClose();
              cinemaNavigate({ film: d.radarrId });
            }}
            className="flex h-9 w-9 items-center justify-center rounded-full bg-white/10 text-white"
          >
            <Film size={15} />
          </button>
        )}
        <button
          type="button"
          aria-label={d.state === "done" || d.state === "failed" ? t("player.downloads.remove") : t("player.downloads.cancel")}
          title={d.state === "done" || d.state === "failed" ? t("player.downloads.remove") : t("player.downloads.cancel")}
          onClick={() => setConfirming(true)}
          className="flex h-9 w-9 items-center justify-center rounded-full bg-white/10 text-danger"
        >
          <Trash2 size={15} />
        </button>
      </div>
      {/* Toujours une confirmation : un film retéléchargé, c'est des centaines de Mo (Louis, 19/10/2026). */}
      <ActionSheet
        open={confirming}
        onClose={() => setConfirming(false)}
        role="alertdialog"
        centerOnWide
        title={d.title}
        subtitle={t("player.downloads.confirmRemove")}
        poster={poster}
        actions={[
          { label: t("player.downloads.remove"), icon: <Trash2 size={18} />, variant: "danger", onClick: () => void removeOfflineDownload(d.id) },
          { label: t("common.cancel"), icon: <X size={18} />, onClick: () => {} },
        ]}
      />
    </li>
  );
}

/** L'affiche gardée sur l'appareil — la liste s'affiche aussi sans réseau. */
function usePosterUrl(d: OfflineDownload): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    const account = offlineAccount();
    if (!d.hasPoster || !account) return;
    let made: string | null = null;
    let cancelled = false;
    void deviceStore
      .readPoster(account, d.id)
      .then((blob) => {
        if (cancelled || !blob) return;
        made = URL.createObjectURL(blob);
        setUrl(made);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      if (made) URL.revokeObjectURL(made);
    };
  }, [d.id, d.hasPoster]);
  return url;
}
