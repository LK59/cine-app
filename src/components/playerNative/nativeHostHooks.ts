// Trois hooks de rendu du lecteur natif (`ExperimentalPlayerHost.tsx`), sortis tels quels de son
// module le 23/10/2026 : l'horloge d'une attente et les étiquettes des pistes. Rien n'y a changé.
import { useEffect, useMemo, useState } from "react";
import { useT, useLocale } from "@/components/TranslationProvider";
import { labelAudioTracks, labelSubtitleTracks } from "@/lib/trackLabel";
import type { PlayerTrack } from "@/lib/webcodecs/playerTrack";
import type { DirectPlayInfo } from "@/app/api/jellyfin/direct/[itemId]/route";

/**
 * Milliseconds since a moment, or null when there is no moment.
 *
 * Ticks only while something is actually pending: an idle player runs no timer at all, which is
 * the point of taking a start time rather than a boolean.
 */
export function useElapsedSince(startedAt: number | null): number | null {
  // The clock is sampled by the timer and kept in state, never read while rendering: a render
  // that reads the time is not a pure function of its inputs, and writing the state from inside
  // the effect instead is the other way to get this wrong. Between the start and the first tick
  // the answer is simply zero, which is well inside the threshold below which nothing is shown.
  const [sampledAt, setSampledAt] = useState(() => Date.now());

  useEffect(() => {
    if (startedAt === null) return;
    const id = setInterval(() => setSampledAt(Date.now()), 100);
    return () => clearInterval(id);
  }, [startedAt]);

  return startedAt === null ? null : Math.max(0, sampledAt - startedAt);
}

/**
 * Les étiquettes des sous-titres — langue et type, dans la même forme que l'audio.
 *
 * Les pistes externes portent un identifiant négatif (voir `ExternalSubtitle`), ce qui suffit à
 * les reconnaître sans leur ajouter un champ.
 */
export function useSubtitleLabels(tracks: PlayerTrack[], origins: ReadonlyMap<number, "generating" | "generated">) {
  const t = useT();
  const { locale } = useLocale();
  return useMemo(() => {
    const etiquettes = labelSubtitleTracks(
      // L'origine d'une piste générée — en cours ou finie — passe par la forme unique des noms
      // (`trackLabel.ts`, DECISIONS.md §70) : le type y devient « génération… » puis « généré ».
      tracks.map((track) => ({ ...track, isExternal: track.number < 0, origin: origins.get(track.number) })),
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
    return new Map(etiquettes.map((e) => [e.number, e.label]));
  }, [tracks, origins, locale, t]);
}

/**
 * Les étiquettes des pistes audio, dans la forme partagée par toute l'application.
 *
 * Le fichier et Jellyfin décrivent les mêmes pistes, chacun avec ce que l'autre n'a pas : le
 * premier porte la langue et le nom bruts, le second le profil — Atmos, DTS-HD MA — et un nombre
 * de canaux déjà résolu. On les apparie dans l'ordre, comme `jellyfinAudioIndex` le fait déjà, et
 * on étiquette avec les deux. Sans Jellyfin, l'étiquette est simplement moins précise.
 */
export function useAudioLabels(fileTracks: PlayerTrack[], jellyfin: DirectPlayInfo["audio"] | undefined, originalLanguage: string | null) {
  const t = useT();
  const { locale } = useLocale();
  return useMemo(() => {
    const apparie = jellyfin && jellyfin.length === fileTracks.length ? jellyfin : null;
    const faits = fileTracks.map((track, i) => ({
      ...track,
      codecId: track.codecId || apparie?.[i]?.codec || null,
      channels: track.channels ?? apparie?.[i]?.channels ?? null,
      profile: apparie?.[i]?.profile ?? null,
      name: track.name ?? apparie?.[i]?.displayTitle ?? null,
    }));
    const etiquettes = labelAudioTracks(faits, {
      locale,
      originalLanguage,
      canaux: (n) => t("player.trackLabel.channels", { n }),
      piste: (n) => t("player.trackLabel.track", { n }),
    });
    return new Map(etiquettes.map((e) => [e.number, e.label]));
  }, [fileTracks, jellyfin, originalLanguage, locale, t]);
}
