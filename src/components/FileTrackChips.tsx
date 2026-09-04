"use client";

import { Mic2, Captions } from "lucide-react";
import type { FileTrack } from "@/lib/fileTracks";
import { channelLayout } from "@/lib/fileTracks";
import { useLocale } from "@/components/TranslationProvider";

/**
 * Le nom d'une langue dans celle du lecteur, sans table à tenir à jour.
 *
 * `Intl.DisplayNames` connaît les deux cent et quelques codes ISO et les traduit dans les quatre
 * langues de l'app. Là où il n'existe pas, le code brut en majuscules fait l'affaire.
 */
function languageName(code: string | null, locale: string): string | null {
  if (!code) return null;
  try {
    return new Intl.DisplayNames([locale], { type: "language" }).of(code) ?? code.toUpperCase();
  } catch {
    return code.toUpperCase();
  }
}

/**
 * Une piste, décrite par ce qui la distingue des autres.
 *
 * Quatre vignettes « English English French French » ne disent rien de plus qu'une seule : c'est
 * ce que donnait la liste aplatie de Bazarr. Chaque vignette porte donc maintenant la langue,
 * puis ce qui la sépare de sa voisine — le codec et le nombre de canaux pour l'audio, la nature
 * du sous-titre (forcé, sourds et malentendants, fichier externe) pour les sous-titres.
 */
function TrackChip({ track, locale, kind }: { track: FileTrack; locale: string; kind: "audio" | "subtitle" }) {
  const name = languageName(track.language, locale) ?? track.title ?? "?";
  const marks: string[] = [];

  if (kind === "audio") {
    const layout = channelLayout(track.channels);
    if (track.codec) marks.push(layout ? `${track.codec} ${layout}` : track.codec);
    else if (layout) marks.push(layout);
    if (track.atmos) marks.push("Atmos");
  } else {
    // Vérifié sur la bibliothèque : ces quatre-là ne se distinguent que par ces trois marques.
    // « VFF Forced : ASS », « VFF Full : ASS », « VFF Forced : SRT », « VFF Full : SRT »
    // deviennent « forcé · ASS », « ASS », « forcé · SRT », « SRT ».
    if (track.forced) marks.push("forcé");
    if (track.hearingImpaired) marks.push("SDH");
    if (track.codec) marks.push(track.codec);
    // Ce qui explique deux vignettes identiques : l'une est dans le conteneur, l'autre est un
    // fichier posé à côté du film.
    if (track.external) marks.push("fichier");
  }

  return (
    <span
      className={`badge inline-flex items-center gap-1.5 ${
        track.isDefault ? "bg-white/10 text-slate-200" : "bg-white/5 text-slate-300"
      }`}
      // Le nom que la piste se donne, gardé au survol : il est souvent plus parlant que tout le
      // reste (« FR VFI », « VFQ »), mais trop long et trop irrégulier pour la vignette.
      title={[track.title, track.isDefault ? "Piste par défaut" : null].filter(Boolean).join(" — ") || undefined}
    >
      <span className="capitalize">{name}</span>
      {marks.length > 0 && <span className="text-[10px] text-slate-500">{marks.join(" · ")}</span>}
    </span>
  );
}

export function FileTrackChips({ audio, subtitles }: { audio: FileTrack[]; subtitles: FileTrack[] }) {
  const { locale } = useLocale();
  if (audio.length === 0 && subtitles.length === 0) return null;

  return (
    <div className="mt-3 space-y-2 border-t border-white/5 pt-3">
      {audio.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <Mic2 size={14} className="shrink-0 text-accent-400" />
          {audio.map((track, i) => (
            <TrackChip key={i} track={track} locale={locale} kind="audio" />
          ))}
        </div>
      )}
      {subtitles.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <Captions size={14} className="shrink-0 text-accent-400" />
          {subtitles.map((track, i) => (
            <TrackChip key={i} track={track} locale={locale} kind="subtitle" />
          ))}
        </div>
      )}
    </div>
  );
}
