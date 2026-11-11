import { useMemo } from "react";
import { labelAudioTracks, labelSubtitleTracks } from "@/lib/trackLabel";
import { useStore, useT } from "../state/store";

/**
 * Les noms des pistes du titre en cours : ceux du lecteur de l'application (`@/lib/trackLabel`), dans la langue
 * du compte. Lus par le panneau (`NowPlaying`) et par la télécommande — un seul calcul, pour que les deux
 * listes disent la même chose.
 */
export function useTrackLabels() {
  const t = useT();
  const lang = useStore((s) => s.lang);
  const audioTracks = useStore((s) => s.playback.audioTracks);
  const subtitleTracks = useStore((s) => s.playback.subtitleTracks);
  const audio = useMemo(
    () =>
      labelAudioTracks(
        audioTracks.map((track) => ({ number: track.index, language: track.language, name: track.title, isDefault: track.isDefault, isForced: false, codecId: track.codec, channels: track.channels, profile: track.profile })),
        { locale: lang, canaux: (n) => `${n} ${t("track.channels")}`, piste: (n) => `${t("track.track")} ${n}` }
      ),
    [audioTracks, lang, t]
  );
  const subtitles = useMemo(
    () =>
      labelSubtitleTracks(
        subtitleTracks.map((track) => ({ number: track.index, language: track.language, name: track.title, isDefault: track.isDefault, isForced: track.isForced, isHearingImpaired: track.isHearingImpaired, isExternal: track.isExternal })),
        { locale: lang, forces: t("track.forced"), complets: t("track.full"), malentendants: t("track.sdh"), externe: t("track.external"), piste: (n) => `${t("track.track")} ${n}` }
      ),
    [subtitleTracks, lang, t]
  );
  return { audio, subtitles };
}
