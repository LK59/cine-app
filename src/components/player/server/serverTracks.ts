/**
 * Les pistes d'une négociation du lecteur serveur, dans les termes des menus : les mêmes étiquettes
 * que le lecteur natif (`trackLabel.ts`), et le sous-titre dans ceux du choix des pistes.
 */
import type { Track } from "@/components/PlayerControls";
import type { useT } from "@/components/TranslationProvider";
import { labelAudioTracks, labelSubtitleTracks } from "@/lib/trackLabel";

type Translate = ReturnType<typeof useT>;

export interface ExternalSubtitleTrack {
  index: number;
  url: string;
  /**
   * L'étiquette construite ici, et non reçue du serveur.
   *
   * Elle sert deux fois : dans notre menu, et dans l'attribut `label` de la balise `<track>` —
   * que le navigateur affiche dans **son propre** sélecteur, et que l'Apple TV montre en AirPlay.
   * D'où l'importance qu'elle se tienne hors de notre interface aussi.
   */
  label: string;
  language?: string | null;
  title?: string | null;
  isDefault: boolean;
  isForced?: boolean;
  isHearingImpaired?: boolean;
  isExternal?: boolean;
}

/** Une piste de ce lecteur, dans les termes du choix des pistes (`trackPreferences`) — §87. */
export function subtitleFacts(st: ExternalSubtitleTrack) {
  return {
    number: st.index,
    language: st.language ?? null,
    name: st.title ?? null,
    isDefault: st.isDefault,
    isForced: st.isForced ?? false,
    isHearingImpaired: st.isHearingImpaired,
  };
}

export function subtitleFactsOf(tracks: readonly ExternalSubtitleTrack[], id: number | null) {
  const found = id === null ? undefined : tracks.find((st) => st.index === id);
  return found ? subtitleFacts(found) : null;
}

/** Une piste audio telle que la route de négociation la décrit. */
export interface ServerAudioFacts {
  index: number;
  language: string | null;
  title: string | null;
  codec: string | null;
  channels: number | null;
  profile: string | null;
  isDefault: boolean;
}

export function serverAudioTracks(faitsAudio: readonly ServerAudioFacts[], originalLanguage: string | null, locale: string, t: Translate): Track[] {
  return labelAudioTracks(
    faitsAudio.map((t) => ({
      number: t.index,
      language: t.language,
      name: t.title,
      isDefault: t.isDefault,
      isForced: false,
      codecId: t.codec,
      channels: t.channels,
      profile: t.profile,
    })),
    {
      locale,
      originalLanguage,
      canaux: (n: number) => t("player.trackLabel.channels", { n }),
      piste: (n: number) => t("player.trackLabel.track", { n }),
    }
  ).map((e) => ({ id: e.number, label: e.label }));
}

export function serverSubtitleTracks(faitsSt: readonly Omit<ExternalSubtitleTrack, "label">[], locale: string, t: Translate): ExternalSubtitleTrack[] {
  const etiquettesSt = new Map(
    labelSubtitleTracks(
      faitsSt.map((st) => ({
        number: st.index,
        language: st.language ?? null,
        name: st.title ?? null,
        isDefault: st.isDefault,
        isForced: st.isForced ?? false,
        isHearingImpaired: st.isHearingImpaired,
        isExternal: st.isExternal,
      })),
      {
        locale,
        forces: t("player.trackLabel.forced"),
        complets: t("player.trackLabel.full"),
        malentendants: t("player.trackLabel.sdh"),
        externe: t("player.trackLabel.external"),
        piste: (n: number) => t("player.trackLabel.track", { n }),
      }
    ).map((e) => [e.number, e.label])
  );
  return faitsSt.map((st) => ({
    ...st,
    label: etiquettesSt.get(st.index) ?? String(st.index),
  }));
}
