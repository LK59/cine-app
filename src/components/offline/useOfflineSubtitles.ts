"use client";

import { useEffect, useMemo, useState, type RefObject } from "react";
import { useLocale, useT } from "@/components/TranslationProvider";
import { labelSubtitleTracks } from "@/lib/trackLabel";
import { cueTextAt, parseSubtitles } from "@/lib/webcodecs/externalSubtitles";
import type { SubtitleCue } from "@/lib/webcodecs/subtitleMarkup";
import { offlineAccount, type OfflineDownload } from "@/lib/offline/downloads";
import { readOfflineSubtitle } from "@/lib/offline/subtitles";

/**
 * Les sous-titres du lecteur hors ligne : les pistes gardées avec le téléchargement, nommées comme
 * dans les autres lecteurs (`labelSubtitleTracks`), lues depuis l'appareil et affichées par le même
 * calque (`SubtitleLayer`). Aucune au départ ; le choix vaut pour la séance.
 */
export function useOfflineSubtitles(download: OfflineDownload | null, videoRef: RefObject<HTMLVideoElement | null>) {
  const t = useT();
  const { locale } = useLocale();
  const [current, setCurrent] = useState<number | null>(null);
  const [cues, setCues] = useState<readonly SubtitleCue[]>([]);
  const [text, setText] = useState<string | null>(null);
  const subtitles = download?.subtitles;
  const id = download?.id;

  const tracks = useMemo(() => {
    const list = subtitles ?? [];
    const labels = labelSubtitleTracks(
      list.map((s) => ({ number: s.index, language: s.language, name: s.title, isDefault: false, isForced: s.isForced, isHearingImpaired: s.isHearingImpaired, isExternal: s.isExternal })),
      {
        locale,
        forces: t("player.trackLabel.forced"),
        complets: t("player.trackLabel.full"),
        malentendants: t("player.trackLabel.sdh"),
        externe: t("player.trackLabel.external"),
        genere: t("player.trackLabel.generated"),
        enCours: t("player.trackLabel.generating"),
        piste: (n) => t("player.trackLabel.track", { n }),
      }
    );
    return labels.map((l) => ({ id: l.number, label: l.label }));
  }, [subtitles, locale, t]);

  // La piste choisie, lue sur l'appareil.
  useEffect(() => {
    const account = offlineAccount();
    if (current === null || !account || !id) return;
    let cancelled = false;
    void readOfflineSubtitle(account, id, current).then((vtt) => {
      if (!cancelled) setCues(vtt ? parseSubtitles(vtt) : []);
    });
    return () => {
      cancelled = true;
    };
  }, [current, id]);

  // La ligne à l'instant, suivie à chaque `timeupdate` (et au saut).
  useEffect(() => {
    const video = videoRef.current;
    if (!video || current === null) return;
    const read = () => setText(cueTextAt(cues, video.currentTime));
    read();
    video.addEventListener("timeupdate", read);
    video.addEventListener("seeked", read);
    return () => {
      video.removeEventListener("timeupdate", read);
      video.removeEventListener("seeked", read);
    };
  }, [cues, current, videoRef]);

  const choose = (next: number | null) => {
    setCurrent(next);
    setCues([]);
    setText(null);
  };
  return { tracks, current, choose, text: current === null ? null : text };
}
