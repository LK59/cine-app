import { chooseAudioTrack, type NamedTrack, type TrackPreferences } from "@/lib/trackPreferences";

/**
 * La piste son sur laquelle un chemin de lecture s'ouvre — la règle de `preferredAudio`
 * (`remuxPlayback.ts`, le lecteur actuel), sortie telle quelle le 17/11/2026 pour que Lumen serveur
 * (`LumenServerHost`, DECISIONS.md §180) s'ouvre sur **la même** piste par la même fonction : seuls
 * changent les deux questions posées au chemin — « la porte-t-il ? » (`playable`) et « qu'en livre-t-il ? »
 * (`delivered`). Pour le lecteur actuel, `playableAudio` et `deliveredAudio` du remultiplexeur ; pour Lumen
 * serveur, les pistes que le serveur sert (`servable`), copiées telles quelles, à leurs canaux.
 *
 * L'ordre, inchangé (CLAUDE.md « Which audio track is opened ») :
 * - la langue du compte d'abord, parmi les pistes jouables (`chooseAudioTrack`, la fonction de l'écran) ;
 * - rien de jouable : le défaut du fichier, pour que le refus nomme son vrai codec ;
 * - sinon, la langue de la piste par défaut du fichier, et la plus riche en canaux livrés, puis la copie.
 */
export function preferredOpeningTrack<T extends NamedTrack>(
  audio: readonly T[],
  playable: (track: T) => boolean,
  delivered: (track: T) => { channels: number; copied: boolean },
  preferences?: TrackPreferences | null
): T | null {
  const usable = audio.filter(playable);
  if (preferences && usable.length > 0) {
    const wanted = chooseAudioTrack(usable, preferences, playable, delivered);
    if (wanted) return wanted;
  }
  if (usable.length === 0) return audio.find((t) => t.isDefault) ?? audio[0] ?? null;

  const preferred = audio.find((t) => t.isDefault) ?? audio[0];
  const language = preferred?.language ?? null;
  const sameLanguage = usable.filter((t) => t.language === language);
  const pool = sameLanguage.length > 0 ? sameLanguage : usable;
  return pool.reduce((best, t) => {
    const [a, b] = [delivered(t), delivered(best)];
    return a.channels > b.channels || (a.channels === b.channels && a.copied && !b.copied) ? t : best;
  }, pool[0]);
}
