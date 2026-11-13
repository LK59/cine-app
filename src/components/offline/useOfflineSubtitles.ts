"use client";

import { useCallback, useEffect, useMemo, useState, type RefObject } from "react";
import { pickReplaySubtitle } from "@/lib/replaySubtitles";
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
  // L'aide d'un passage rejoué (§150) : montrée à la place de la piste choisie le temps du passage, sans la changer.
  const [replay, setReplay] = useState<number | null>(null);
  const shown = replay ?? current;
  const [text, setText] = useState<string | null>(null);
  const subtitles = download?.subtitles;
  const id = download?.id;
  /**
   * Les lignes lues, avec la piste et le téléchargement dont elles viennent : valables tant que c'est
   * encore cette piste qu'on montre (13/11/2026). Elles étaient vidées à chaque choix, alors que la
   * lecture ne se relance qu'au changement de piste montrée : « Garder » l'aide d'un passage rejoué
   * (l'aide retirée et la même piste choisie, dans le même rendu) ou rechoisir la piste active laissait la
   * même piste montrée, sans lignes — les sous-titres qu'on venait de garder disparaissaient.
   */
  const [loaded, setLoaded] = useState<{ id: string; track: number; cues: readonly SubtitleCue[] } | null>(null);
  const cues = loaded && loaded.id === id && loaded.track === shown ? loaded.cues : NO_CUES;

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

  // La piste montrée (la choisie, ou l'aide), lue sur l'appareil.
  useEffect(() => {
    const account = offlineAccount();
    if (shown === null || !account || !id) return;
    let cancelled = false;
    void readOfflineSubtitle(account, id, shown).then((vtt) => {
      if (!cancelled) setLoaded({ id, track: shown, cues: vtt ? parseSubtitles(vtt) : NO_CUES });
    });
    return () => {
      cancelled = true;
    };
  }, [shown, id]);

  // La ligne à l'instant, suivie à chaque `timeupdate` (et au saut).
  useEffect(() => {
    const video = videoRef.current;
    if (!video || shown === null) return;
    const read = () => setText(cueTextAt(cues, video.currentTime));
    read();
    video.addEventListener("timeupdate", read);
    video.addEventListener("seeked", read);
    return () => {
      video.removeEventListener("timeupdate", read);
      video.removeEventListener("seeked", read);
    };
  }, [cues, shown, videoRef]);

  // Rien à vider : une autre piste montrée n'a pas de lignes tant qu'elles ne sont pas lues (`cues`), et
  // la ligne à l'instant se relit au changement (l'effet plus haut).
  const choose = (next: number | null) => {
    setCurrent(next);
  };
  // Gardés avec le téléchargement, ce sont des WebVTT : du texte, toujours. La langue de l'audio n'est notée que
  // pour un épisode (celle demandée, reprise au suivant) ; un film part de la langue du compte.
  const audioLanguage = download?.episode?.audioLanguage ?? null;
  const replayTrack = useCallback(
    () =>
      pickReplaySubtitle({
        tracks: (subtitles ?? []).map((s) => ({
          id: s.index,
          language: s.language,
          name: s.title,
          isDefault: false,
          isForced: s.isForced,
          isHearingImpaired: s.isHearingImpaired,
          text: true,
        })),
        current,
        audioLanguage,
        accountLanguages: [locale],
      }),
    [subtitles, current, audioLanguage, locale]
  );
  const showReplay = useCallback((next: number | null) => {
    setReplay(next);
  }, []);
  const replaySubtitle = useMemo(() => ({ track: replayTrack, show: showReplay }), [replayTrack, showReplay]);
  return { tracks, current, choose, text: shown === null ? null : text, replaySubtitle };
}

const NO_CUES: readonly SubtitleCue[] = [];
