/**
 * Choosing a track the way the viewer's Jellyfin account says to, on files that name their
 * tracks however they please.
 *
 * Measured on this library, which is what every rule below is for:
 *
 *  * The container says `fre`. Jellyfin's preference says `fra`. Both mean French — they are the
 *    bibliographic and the terminological halves of ISO 639-2, and comparing them as strings
 *    matches nothing, ever. Twenty languages have that split and French is one of them.
 *  * Track names are free text and are used as such: "FR VFF : AC3 5.1", "VFQ", "French
 *    (France)", "VFi EAC3 5.1 DDP", "Espagnol [VO]".
 *  * Three audio tracks out of 1425 carry no language at all, and say what they are only in
 *    their name.
 *  * At least one is named "French (France) AD" — an audio description. Picking it because it
 *    is French would hand a blind-accessibility mix to someone who asked for French.
 */

/** A track, as either pipeline describes one. */
export interface NamedTrack {
  language: string | null;
  name: string | null;
  isDefault: boolean;
  isForced: boolean;
}

/**
 * The twenty languages ISO 639-2 spells two ways, mapped to their 639-1 code.
 *
 * Only these matter: everywhere else the bibliographic and terminological codes are identical,
 * so a straight comparison already works.
 */
const TWO_WAYS: Record<string, string> = {
  alb: "sq", sqi: "sq", arm: "hy", hye: "hy", baq: "eu", eus: "eu", bur: "my", mya: "my",
  chi: "zh", zho: "zh", cze: "cs", ces: "cs", dut: "nl", nld: "nl", fre: "fr", fra: "fr",
  geo: "ka", kat: "ka", ger: "de", deu: "de", gre: "el", ell: "el", ice: "is", isl: "is",
  mac: "mk", mkd: "mk", mao: "mi", mri: "mi", may: "ms", msa: "ms", per: "fa", fas: "fa",
  rum: "ro", ron: "ro", slo: "sk", slk: "sk", tib: "bo", bod: "bo", wel: "cy", cym: "cy",
};

/** The few three-letter codes worth reducing to two, beyond the pairs above. */
const TO_TWO: Record<string, string> = {
  eng: "en", spa: "es", ita: "it", por: "pt", rus: "ru", jpn: "ja", kor: "ko", ara: "ar",
  heb: "he", hin: "hi", tur: "tr", pol: "pl", swe: "sv", nor: "no", dan: "da", fin: "fi",
  hun: "hu", ukr: "uk", tha: "th", vie: "vi", ind: "id", cat: "ca", lat: "la",
};

/**
 * One comparable name for a language, whatever it was written as.
 *
 * `fre`, `fra`, `fr`, `fr-FR` and `FR` all come back as "fr". A code this does not recognise is
 * lowercased and handed back as it is, so two files agreeing on an unusual language still match
 * each other.
 */
export function normaliseLanguage(tag: string | null | undefined): string | null {
  if (!tag) return null;
  const clean = tag.trim().toLowerCase().replace(/_/g, "-");
  if (!clean || clean === "und" || clean === "mis" || clean === "zxx" || clean === "mul") return null;
  const base = clean.split("-")[0];
  return TWO_WAYS[base] ?? TO_TWO[base] ?? base;
}

/** Words that name a language in a track title, when the track itself does not. */
const NAMED_IN_TITLE: [RegExp, string][] = [
  [/\b(vff|vfq|vfi|vf|vfb)\b|fran[çc]ais|french/i, "fr"],
  // Not "VO": that means *version originale*, and this library has a track named
  // "Espagnol [VO]" whose original version is Spanish. It says a track is not dubbed, which is
  // not the same as saying what language it is in.
  [/\benglish\b|anglais/i, "en"],
  [/espa[ñn]ol|spanish|espagnol/i, "es"],
  [/deutsch|german|allemand/i, "de"],
  [/italiano|italian|italien/i, "it"],
  [/portugu[êe]s|portuguese/i, "pt"],
  [/日本語|japanese|japonais/i, "ja"],
];

/**
 * An audio description: a mix with a narrator describing the picture.
 *
 * Never chosen automatically. Handing one to somebody who asked for French because it happens to
 * be French is worse than handing them the file's own default — and it is a real track in this
 * library, named "French (France) AD".
 */
export function isAudioDescription(track: NamedTrack): boolean {
  const name = track.name ?? "";
  return /\bad\b|audio[- ]?description|descriptive|narration|visually impaired|malvoyant/i.test(name);
}

/** Whether a track is a commentary, which nobody asked for by asking for a language. */
export function isCommentary(track: NamedTrack): boolean {
  return /commentaire|commentary|director'?s? track/i.test(track.name ?? "");
}

/**
 * What language a track is in.
 *
 * The code is believed first and the name is only read when there is no code — a name is free
 * text and a code is not, so preferring the name would be preferring the less reliable of the
 * two. That is also why a name is never allowed to contradict a code.
 */
export function trackLanguage(track: NamedTrack): string | null {
  const declared = normaliseLanguage(track.language);
  if (declared) return declared;
  for (const [pattern, language] of NAMED_IN_TITLE) {
    if (pattern.test(track.name ?? "")) return language;
  }
  return null;
}

/** What the viewer's Jellyfin account asks for. */
export interface TrackPreferences {
  audioLanguage: string | null;
  subtitleLanguage: string | null;
  /** Jellyfin's own vocabulary. Anything unrecognised is treated as "Default". */
  subtitleMode: "Default" | "Always" | "OnlyForced" | "None" | "Smart" | null;
  /** When true, the file's own default track wins over the language preference. */
  playDefaultAudioTrack: boolean;
}

function rank<T extends NamedTrack>(tracks: T[], wanted: string | null): T[] {
  return tracks
    .map((track, order) => {
      const language = trackLanguage(track);
      let score = 0;
      if (wanted && language === wanted) score += 100;
      // A track that says nothing about its language is not evidence of anything — it is only
      // ever taken when nothing better exists, and never mistaken for the language asked for.
      else if (language === null) score += 10;
      if (track.isDefault) score += 5;
      if (isAudioDescription(track)) score -= 200;
      if (isCommentary(track)) score -= 150;
      return { track, score, order };
    })
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .map((entry) => entry.track);
}

/**
 * The audio track to open with, or null to leave the file's own choice alone.
 *
 * Returns null rather than a guess whenever the preference cannot be honoured: a viewer who asks
 * for French and gets handed the only other track has been given a film in a language they did
 * not ask for, and told nothing about it.
 */
export function chooseAudioTrack<T extends NamedTrack>(tracks: T[], preferences: TrackPreferences): T | null {
  if (tracks.length === 0) return null;
  if (preferences.playDefaultAudioTrack) return null;
  const wanted = normaliseLanguage(preferences.audioLanguage);
  if (!wanted) return null;

  const best = rank(tracks, wanted)[0];
  return best && trackLanguage(best) === wanted ? best : null;
}

/**
 * The subtitle track to show, or null for none — which is a decision, not an absence of one.
 *
 * Jellyfin's five modes, kept as they are rather than reduced: they are what the viewer set on
 * their account, and a player that reinterprets them is a player that disagrees with the server
 * about what the viewer asked for.
 */
export function chooseSubtitleTrack<T extends NamedTrack>(
  tracks: T[],
  preferences: TrackPreferences,
  audioLanguage: string | null
): T | null {
  const mode = preferences.subtitleMode ?? "Default";
  if (mode === "None" || tracks.length === 0) return null;

  const wanted = normaliseLanguage(preferences.subtitleLanguage);
  const spoken = normaliseLanguage(audioLanguage);
  const inWanted = tracks.filter((track) => !wanted || trackLanguage(track) === wanted);

  // Only the forced ones, which exist to translate a sign or a line spoken in another language
  // inside a film the viewer otherwise understands.
  if (mode === "OnlyForced") return inWanted.find((track) => track.isForced) ?? null;

  // Nothing to translate: the film is already being heard in the language the subtitles would
  // have been in. Forced ones still apply, for the lines the audio itself does not cover.
  if ((mode === "Smart" || mode === "Default") && wanted && spoken === wanted) {
    return inWanted.find((track) => track.isForced) ?? null;
  }

  if (inWanted.length === 0) return null;
  // A full track first: at this point the viewer is being shown subtitles because they cannot
  // follow the audio, and a forced track carries only the handful of lines the film itself
  // treats as foreign.
  return inWanted.find((track) => !track.isForced) ?? inWanted[0];
}
