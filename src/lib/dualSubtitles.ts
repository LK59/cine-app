import type React from "react";
import { overlayCss, type SubtitleColor, type SubtitleStyle } from "./subtitleStyle";
import { isForcedTrack, titleSaysHearingImpaired, trackLanguage, type NamedTrack } from "./trackPreferences";

/**
 * « Deux sous-titres » (DECISIONS.md §87) : un sous-titre principal, dessiné comme toujours, et un
 * second juste au-dessus, plus petit et d'une teinte plus douce — pour apprendre une langue, ou
 * regarder à deux qui ne lisent pas la même.
 *
 * Ce module porte ce qui ne dépend d'aucun des deux lecteurs : l'apparence du second, ce qu'on retient
 * sur l'appareil, et comment le retrouver au film suivant. Les deux hôtes (natif et serveur) et le
 * menu (`PlayerControls`) passent par ici — un choix fait deux fois finit par diverger.
 */

/** Le second, à 80 % du principal : présent sans lui disputer l'œil. */
export const SECOND_SUBTITLE_SCALE = 0.8;

/**
 * La teinte du second, selon la couleur choisie pour le principal (`SubtitleStyle.color`) : un blanc
 * légèrement grisé sous un principal blanc, un jaune pâle, presque crème, sous un principal jaune.
 * Assez proche pour se lire comme la même famille, assez loin pour que l'œil sache d'emblée laquelle
 * est la sienne. Même contour, même ombre que le principal — c'est elle qui le garde lisible sur une
 * image claire, pas la couleur.
 */
export const SECOND_SUBTITLE_TINT: Record<SubtitleColor, string> = {
  white: "#d5d8dd",
  yellow: "#e8e0b4",
};

/**
 * Le facteur de taille en mode deux sous-titres, lu dans `--dual-k` : 1, et 0,9 dans une zone plus
 * haute que large (téléphone en portrait — `.subtitle-dual` dans globals.css). Écrit sur la taille du
 * **mode**, jamais sur la présence d'une réplique du second : sinon le principal rétrécirait à chaque
 * ligne du second qui apparaît.
 */
function dualFont(fontSize: React.CSSProperties["fontSize"]): string {
  return `calc(var(--dual-k, 1) * ${String(fontSize)})`;
}

/** Le principal en mode deux sous-titres : son apparence ordinaire, au facteur du mode. */
export function primaryDualCss(style: SubtitleStyle): React.CSSProperties {
  const base = overlayCss(style);
  return { ...base, fontSize: dualFont(base.fontSize) };
}

/**
 * Le plus petit second qu'on accepte : 11 px, la plus petite taille de texte qu'Apple admet (Caption 2).
 * Mesuré le 14/10/2026 sur un rendu fidèle à 390 × 844 (téléphone en portrait, taille « Normale ») :
 * le principal y fait 12,6 px, et le second à 80 % tombait à 10,1 px — sous ce seuil, lu à bout de
 * bras. Jamais plus grand que le principal : à une taille où le principal est lui-même sous 11 px
 * (« Très petite » au téléphone), le second prend sa taille, et seule la teinte les distingue.
 */
export const SECOND_SUBTITLE_MIN_PX = 11;

/** Le second : 80 % du principal (11 px au moins), sa teinte douce, le même fond ou la même ombre. */
export function secondOverlayCss(style: SubtitleStyle): React.CSSProperties {
  const base = overlayCss({ ...style, size: style.size * SECOND_SUBTITLE_SCALE });
  const primary = dualFont(overlayCss(style).fontSize);
  return { ...base, fontSize: `max(min(${SECOND_SUBTITLE_MIN_PX}px, ${primary}), ${dualFont(base.fontSize)})`, color: SECOND_SUBTITLE_TINT[style.color] };
}

// --- ce que l'appareil retient ----------------------------------------------------------------

/**
 * Les deux langues du dernier choix « deux sous-titres », sur cet appareil — comme l'apparence
 * (`cine:subtitle-style`). Des langues et non des numéros de pistes : un numéro ne veut rien dire
 * d'un fichier à l'autre. `null` : un seul sous-titre.
 */
export interface DualMemory {
  primary: string | null;
  second: string;
}

const STORAGE_KEY = "cine:dual-subtitles";

export const dualSubtitleMemory = {
  read(): DualMemory | null {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as Partial<DualMemory> & { v?: number };
      if (parsed.v !== 1 || typeof parsed.second !== "string" || !parsed.second) return null;
      return { primary: typeof parsed.primary === "string" && parsed.primary ? parsed.primary : null, second: parsed.second };
    } catch {
      return null;
    }
  },
  write(memory: DualMemory | null): void {
    try {
      if (memory === null) window.localStorage.removeItem(STORAGE_KEY);
      else window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ v: 1, ...memory }));
    } catch {
      // Stockage indisponible (navigation privée) : le choix vaut pour ce film, c'est déjà ça.
    }
  },
};

/**
 * Retient l'état « deux sous-titres » tel qu'il vient de devenir. Un second sans langue connue ne
 * pourrait pas être retrouvé : c'est alors un seul sous-titre qu'on retient.
 */
export function rememberDual(primary: NamedTrack | null, second: NamedTrack | null): void {
  const secondLanguage = second ? trackLanguage(second) : null;
  if (!primary || !secondLanguage) {
    dualSubtitleMemory.write(null);
    return;
  }
  dualSubtitleMemory.write({ primary: trackLanguage(primary), second: secondLanguage });
}

/**
 * La meilleure piste d'une langue pour être lue en entier : jamais une forcée (elle ne traduit que
 * quelques panneaux), une ordinaire plutôt qu'une pour malentendants.
 */
function fullTrackIn<T extends NamedTrack>(tracks: readonly T[], language: string): T | null {
  const inLanguage = tracks.filter((track) => trackLanguage(track) === language && !isForcedTrack(track));
  return (
    inLanguage.find((track) => !(track as { isHearingImpaired?: boolean }).isHearingImpaired && !titleSaysHearingImpaired(track.name)) ??
    inLanguage[0] ??
    null
  );
}

/**
 * Au film suivant : le choix retenu, s'il s'applique ici.
 *
 * Le principal est celui que le lecteur a déjà choisi (préférences du compte, relais d'un autre
 * lecteur) ; faute de principal, celui de la langue retenue. Le second est la piste complète de la
 * langue retenue — autre que le principal, et pas dans la même langue que lui. Une langue absente,
 * et c'est un seul sous-titre : rien n'est inventé, et rien n'est généré sans qu'on l'ait demandé
 * (une génération coûte).
 */
export function pickRememberedDual<T extends NamedTrack & { number: number }>(
  tracks: readonly T[],
  currentPrimary: number | null,
  memory: DualMemory | null
): { primary: T; second: T } | null {
  if (!memory) return null;
  const primary =
    (currentPrimary !== null ? tracks.find((track) => track.number === currentPrimary) : undefined) ??
    (currentPrimary === null && memory.primary ? fullTrackIn(tracks, memory.primary) : null);
  if (!primary || trackLanguage(primary) === memory.second) return null;
  const second = fullTrackIn(
    tracks.filter((track) => track.number !== primary.number),
    memory.second
  );
  return second ? { primary, second } : null;
}
