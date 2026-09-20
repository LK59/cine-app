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
 * Forcée — par le drapeau, ou par son titre quand le drapeau manque.
 *
 * Une piste forcée ne traduit que ce que le film lui-même traite comme étranger : un panneau, une
 * réplique dans une autre langue. C'est le seul sous-titre qu'on veuille voir sur un film qu'on
 * comprend, et c'est sur ce drapeau que reposent les modes « forcés seulement » et « intelligent ».
 *
 * Or le drapeau manque souvent. Relevé le 20/09/2026 sur cette bibliothèque : **51 pistes portent
 * « forcé » dans leur titre sans que `FlagForced` soit posé** — « Français forcés », « forced »,
 * « VFF Forced », « VFQ : Forced » — sur un total de 392. Une sur huit était donc invisible pour
 * le choix automatique, et les films concernés affichaient soit rien, soit une piste complète.
 *
 * Le titre est du texte libre : on ne s'y fie que **faute de drapeau**, jamais contre lui. Et le
 * motif a été écrit deux fois, la première étant fausse de deux façons qu'un test a montrées :
 *
 *  * `\b` ne délimite pas après un `é` — ce n'est pas un caractère de mot pour l'expression
 *    régulière —, donc « Forcé » n'était pas reconnu. D'où des frontières écrites à la main sur
 *    `\p{L}`, qui couvre les lettres accentuées ;
 *  * « Forces spéciales » était pris pour une piste forcée. On ne reconnaît donc que les formes
 *    sans ambiguïté — `forcé`, `forcée`, `forcés`, `forcées`, `forced` — et surtout **pas**
 *    `force` ni `forces`, qui sont des mots français ordinaires.
 */
const DIT_FORCE = /(^|[^\p{L}])forc(é|ée|és|ées|ed)([^\p{L}]|$)/iu;

export function isForcedTrack(track: NamedTrack): boolean {
  return track.isForced || DIT_FORCE.test(track.name ?? "");
}

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
 * Les codes que Jellyfin écrit, et à quoi les ramener.
 *
 * Jellyfin range ses préférences de langue sous le nom terminologique de l'ISO 639-2 — `fra`,
 * `deu` — et pas sous le bibliographique — `fre`, `ger` — que la moitié des fichiers portent.
 * Une liste de choix écrite dans l'autre convention ne peut donc jamais retrouver la préférence
 * enregistrée : elle affiche « peu importe » à un compte qui a bel et bien choisi le français.
 *
 * Vérifié sur le serveur plutôt que supposé : `/Localization/Cultures` donne pour le français
 * `ThreeLetterISOLanguageName: "fra"`, avec `["fra", "fre"]` comme formes acceptées.
 */
const JELLYFIN_CODES: Record<string, string> = {
  fr: "fra", en: "eng", es: "spa", de: "deu", it: "ita", ja: "jpn",
  pt: "por", ru: "rus", nl: "nld", zh: "zho", ko: "kor", ar: "ara", pl: "pol",
};

/**
 * Le code sous lequel Jellyfin connaît cette langue, quelle que soit l'écriture reçue.
 *
 * `fre`, `fra`, `fr` et `fr-FR` reviennent tous « fra ». Une langue hors de la table revient
 * telle qu'elle a été reçue, en minuscules : c'est ce qui permet de l'afficher et de la
 * conserver plutôt que de l'effacer faute de la reconnaître.
 */
export function toJellyfinLanguage(tag: string | null | undefined): string | null {
  const two = normaliseLanguage(tag);
  if (!two) return null;
  return JELLYFIN_CODES[two] ?? two;
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

/**
 * Ce que ce chemin de lecture sait porter — une question, pas une propriété de la piste.
 *
 * La réponse dépend du lecteur et du navigateur : le TrueHD n'a de décodeur nulle part, le DTS en
 * a un chez nous, l'AAC en a un partout. L'appelant la pose donc lui-même.
 */
export type Carriable<T> = (track: T) => boolean;

function rank<T extends NamedTrack>(tracks: T[], wanted: string | null, carriable?: Carriable<T>): T[] {
  return tracks
    .map((track, order) => {
      const language = trackLanguage(track);
      let score = 0;
      if (wanted && language === wanted) score += 100;
      // A track that says nothing about its language is not evidence of anything — it is only
      // ever taken when nothing better exists, and never mistaken for the language asked for.
      else if (language === null) score += 10;
      /**
       * Ce qui joue ici passe devant, à langue égale — décidé le 20/09/2026.
       *
       * « Le Mans 66 » porte deux pistes anglaises : une TrueHD 7.1 et une AC-3 5.1. La première
       * gagnait, parce qu'elle vient en premier dans le fichier ; or rien ne la décode, et le
       * lecteur cédait donc la place au lecteur serveur — six fois pour le même spectateur, qui
       * ne demandait que la VO. Il l'obtient maintenant sans quitter le lecteur natif, en 5.1 au
       * lieu de 7.1.
       *
       * Vingt points : assez pour départager deux pistes de la même langue, jamais assez pour
       * passer devant la langue demandée (cent). Une piste injouable dans la bonne langue reste
       * préférable à une piste jouable dans une autre — c'est bien la langue qu'on a demandée.
       */
      if (carriable && carriable(track)) score += 20;
      if (isAudioDescription(track)) score -= 200;
      if (isCommentary(track)) score -= 150;
      return { track, score, order };
    })
    /**
     * L'ordre des départages, et `isDefault` **après** la richesse — corrigé le 20/09/2026.
     *
     * Il valait cinq points dans le score, donc il passait devant le nombre de canaux, qui n'est
     * qu'un départage. Conséquence visible dans le journal sur « 2001 » : la piste française
     * stéréo, marquée par défaut dans le fichier, battait la française 5.1 — on ouvrait sur la
     * stéréo alors que la 5.1 était là. Ce n'est pas ce qu'on veut dire par « la meilleure ».
     *
     * L'ordre est donc : la langue demandée, puis ce qui joue ici, puis **la plus riche**, puis
     * le drapeau du fichier, puis l'ordre des pistes. Le drapeau garde son rôle — départager deux
     * pistes que rien d'autre ne sépare — et le perd là où il n'avait pas à l'avoir.
     *
     * Rien ne change pour les sous-titres : ils n'ont pas de canaux, donc la comparaison est
     * toujours nulle et `isDefault` tranche exactement comme avant.
     */
    .sort(
      (a, b) =>
        b.score - a.score ||
        canaux(b.track) - canaux(a.track) ||
        Number(b.track.isDefault) - Number(a.track.isDefault) ||
        a.order - b.order
    )
    .map((entry) => entry.track);
}

/**
 * Le nombre de canaux, quelle que soit la forme de la piste.
 *
 * Deux vocabulaires se croisent ici : une piste Matroska le range sous `audio.channels`, une
 * piste telle que l'écran la voit sous `channels`. N'en lire qu'un rendait le départage inerte de
 * l'autre côté — attrapé par un test, et c'est précisément le genre de panne muette qu'un
 * classement silencieux produit : rien n'échoue, on prend simplement la stéréo.
 */
function canaux(track: unknown): number {
  const t = track as { channels?: number | null; audio?: { channels?: number | null } | null };
  const n = t.channels ?? t.audio?.channels;
  return typeof n === "number" ? n : 0;
}

/**
 * The audio track to open with, or null to leave the file's own choice alone.
 *
 * Returns null rather than a guess whenever the preference cannot be honoured: a viewer who asks
 * for French and gets handed the only other track has been given a film in a language they did
 * not ask for, and told nothing about it.
 */
export function chooseAudioTrack<T extends NamedTrack>(
  tracks: T[],
  preferences: TrackPreferences,
  carriable?: Carriable<T>
): T | null {
  if (tracks.length === 0) return null;
  if (preferences.playDefaultAudioTrack) return null;
  const wanted = normaliseLanguage(preferences.audioLanguage);
  if (!wanted) return null;

  const best = rank(tracks, wanted, carriable)[0];
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
  if (mode === "OnlyForced") return inWanted.find(isForcedTrack) ?? null;

  // Nothing to translate: the film is already being heard in the language the subtitles would
  // have been in. Forced ones still apply, for the lines the audio itself does not cover.
  if ((mode === "Smart" || mode === "Default") && wanted && spoken === wanted) {
    return inWanted.find(isForcedTrack) ?? null;
  }

  if (inWanted.length === 0) return null;
  // A full track first: at this point the viewer is being shown subtitles because they cannot
  // follow the audio, and a forced track carries only the handful of lines the film itself
  // treats as foreign.
  return inWanted.find((track) => !isForcedTrack(track)) ?? inWanted[0];
}
