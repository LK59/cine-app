import { normaliseLanguage, trackLanguage, isAudioDescription, isForcedTrack, titleSaysHearingImpaired, type NamedTrack } from "@/lib/trackPreferences";

/**
 * L'étiquette d'une piste, écrite **une seule fois** pour toute l'application.
 *
 * Trois endroits la fabriquaient chacun à sa façon : le menu du lecteur natif collait le code de
 * langue et le titre brut du fichier (`fre — FR VFF : AC3 5.1`), le lecteur stable reprenait le
 * `DisplayTitle` de Jellyfin (`French - Dolby Digital - 5.1 - Par défaut`), et le panneau
 * technique listait les champs un par un. Trois vocabulaires pour une même piste, dont deux
 * recopiaient ce qu'un inconnu avait tapé dans son multiplexeur.
 *
 * La forme est fixe : **langue — codec — canaux**, et rien d'autre ne s'y invite sauf ce qui
 * distingue deux pistes autrement identiques, mis entre parenthèses.
 *
 *     Français — AAC — 5.1
 *     Français AD — Dolby Digital+ — 2.0
 *     Anglais (VO) — DTS-HD MA — 7.1
 *     Anglais (VO) — Dolby Digital+ — 5.1 (Mix 6-Tracks Original du LaserDisc)
 *
 * Ce que la standardisation coûte, et il faut le savoir : le titre libre porte parfois une
 * information que rien d'autre ne porte — « 2001 » a deux pistes anglaises 5.1 en E-AC3 qui sont
 * deux masters différents. La parenthèse est ce qui rattrape ce cas, et elle n'apparaît que là.
 */

/**
 * Le nom d'une langue dans la langue de qui regarde, sans dictionnaire à tenir.
 *
 * `Intl.DisplayNames` est dans tous les navigateurs et dans Node : « en » devient *anglais*,
 * *English*, *inglés*, *Englisch*. Recopier ces quatre listes à la main aurait été deux cents
 * lignes à maintenir pour un résultat moins bon — et l'application parle quatre langues.
 *
 * Le code brut est rendu en dernier recours : une langue que la plateforme ne connaît pas vaut
 * mieux affichée telle quelle qu'effacée.
 */
export function languageName(code: string | null | undefined, locale: string): string | null {
  const tag = normaliseLanguage(code);
  if (!tag) return null;
  try {
    const nom = new Intl.DisplayNames([locale], { type: "language" }).of(tag);
    if (!nom || nom.toLowerCase() === tag.toLowerCase()) return tag.toUpperCase();
    // Les noms de langue sortent en minuscule dans plusieurs locales ; une étiquette commence par
    // une capitale, comme un nom propre.
    return nom.charAt(0).toUpperCase() + nom.slice(1);
  } catch {
    return tag.toUpperCase();
  }
}

/**
 * Le nom commercial du codec, parce que c'est celui que les gens reconnaissent.
 *
 * « Dolby Digital+ » plutôt que « E-AC3 », « DTS-HD MA » plutôt que « dts » : ce sont les noms
 * qu'affichent les autres lecteurs et ceux qui figurent sur les jaquettes. Le profil, quand
 * Jellyfin le donne, précise ce que le codec seul ne dit pas — Atmos, DTS:X, HE-AAC.
 *
 * Le codec arrive sous deux formes selon la source : `A_EAC3` depuis le fichier Matroska, `eac3`
 * depuis Jellyfin. Les deux sont acceptées.
 */
const NOMS: [RegExp, string][] = [
  [/^(a_)?eac3|e-ac-?3|ec-3/i, "Dolby Digital+"],
  [/^(a_)?ac3|ac-3/i, "Dolby Digital"],
  [/^(a_)?truehd|mlp/i, "Dolby TrueHD"],
  [/^(a_)?dts/i, "DTS"],
  [/^(a_)?aac/i, "AAC"],
  [/^(a_)?flac/i, "FLAC"],
  [/^(a_)?opus/i, "Opus"],
  [/^(a_)?vorbis/i, "Vorbis"],
  [/^(a_)?mp3|mpeg\/l3/i, "MP3"],
  [/^(a_)?mp2|mpeg\/l2/i, "MP2"],
  [/^(a_)?pcm/i, "PCM"],
];

/**
 * Les codecs qu'on **tait**, parce qu'ils sont la norme ici.
 *
 * Mesuré sur cette bibliothèque : AAC, Dolby Digital et Dolby Digital+ font 949 pistes sur 1 097.
 * Les écrire dans chaque entrée du menu allongeait l'étiquette jusqu'à la couper à l'écran — les
 * captures du 20/09/2026 montrent « Français — Dolby Digital+ — 5.1 (Piste… » — pour une
 * information qui ne départage rien : quand tout est en Dolby Digital+, le dire n'aide personne à
 * choisir.
 *
 * Ce qu'on garde est ce qui sort de l'ordinaire et qui se voit à l'oreille ou sur une jaquette :
 * l'Atmos, le TrueHD, la famille DTS, et le sans-perte. Le reste tient dans la langue et les
 * canaux, qui sont les deux vraies raisons de choisir une piste.
 */
function estRemarquable(nom: string): boolean {
  return /atmos|truehd|dts|flac|pcm/i.test(nom);
}

export function audioCodecName(codec: string | null | undefined, profile?: string | null): string | null {
  if (!codec) return null;
  const base = NOMS.find(([motif]) => motif.test(codec))?.[1];
  if (!base) {
    // Inconnu : on rend ce qu'on a, nettoyé du préfixe Matroska, plutôt que rien.
    const brut = codec.replace(/^A_/i, "").replace(/\//g, " ").trim();
    return brut || null;
  }
  const p = profile ?? "";
  // Le profil n'est ajouté que lorsqu'il dit quelque chose de plus que le codec. « LC » ne
  // distingue rien pour qui regarde un film ; « Atmos » et « DTS-HD MA », si.
  /**
   * L'Atmos se nomme seul.
   *
   * « Dolby Digital+ Atmos » et « Dolby TrueHD Atmos » disent deux fois la même chose à qui
   * choisit une piste : ce qu'on retient, c'est l'Atmos. C'est aussi ainsi que les plateformes
   * l'écrivent. Vérifié avant de simplifier : **aucun fichier de cette bibliothèque ne porte de
   * l'Atmos dans deux codecs différents**, donc rien ne devient ambigu — et si cela arrivait, le
   * discriminant s'en chargerait.
   */
  if (/atmos/i.test(p)) return "Dolby Atmos";
  if (/dts[-: ]?x\b/i.test(p)) return "DTS:X";
  if (/dts-hd\s*ma/i.test(p)) return "DTS-HD MA";
  if (/dts-hd\s*hra/i.test(p)) return "DTS-HD HRA";
  if (/he-?aac/i.test(p)) return "HE-AAC";
  return base;
}

/**
 * Les canaux nommés — et **seulement ceux qu'on sait nommer**.
 *
 * `CLAUDE.md` le dit sans détour : le nombre de canaux ne nomme pas la disposition. Cinq canaux,
 * c'est un 5.0 dans un fichier et un 4.1 dans un autre ; sept, c'est un 6.1 dont le cinquième
 * rang est un centre arrière. Sur cette bibliothèque, 99,7 % des pistes sont en 1, 2, 6 ou 8
 * canaux — les quatre sans ambiguïté. Les cinq autres pistes affichent leur compte brut plutôt
 * qu'une disposition inventée.
 */
export function channelLayout(channels: number | null | undefined, canaux: (n: number) => string): string | null {
  if (!channels || channels < 1) return null;
  const connus: Record<number, string> = { 1: "1.0", 2: "2.0", 6: "5.1", 8: "7.1" };
  return connus[channels] ?? canaux(channels);
}

/**
 * Les variantes régionales d'une langue, telles que les multiplexeurs les écrivent.
 *
 * « VFQ » et « French (Canadien) » ne sont pas des titres à mettre entre parenthèses au bout de
 * l'étiquette : ce sont des *langues*, et elles ont leur place dans la case prévue. « La Fin
 * d'Oak Street » porte VFF et VFQ, « Disclosure Day » porte French (France) et French (Canadien) —
 * deux fichiers où, sans cela, les deux pistes françaises s'affichent identiques et ne se
 * distinguent que par une parenthèse tronquée à l'écran.
 *
 * Seules les variantes qui s'écartent de la langue de base sont nommées : « VFF » et « French
 * (France) » sont du français tout court, et l'écrire serait du bruit.
 */
const VARIANTES: [RegExp, string][] = [
  [/\bvfq\b|\bvf2\b|qu[ée]b[ée]cois|canadien|\bcanada\b/i, "Canadien"],
  [/\bvfb\b|\bbelge\b/i, "Belge"],
  [/latino|latinoam[ée]ricain/i, "Latino"],
  [/br[ée]silien|brazilian|brasil/i, "Brésilien"],
];

function variante(name: string | null | undefined): string | null {
  if (!name) return null;
  return VARIANTES.find(([motif]) => motif.test(name))?.[1] ?? null;
}

export interface AudioTrackFacts extends NamedTrack {
  /** Le numéro de la piste dans le fichier — dernier recours pour la nommer. */
  number: number;
  codecId?: string | null;
  channels?: number | null;
  /** Ce que Jellyfin sait du profil : « Dolby Digital Plus + Dolby Atmos », « DTS-HD MA »… */
  profile?: string | null;
}

export interface LabelOptions {
  locale: string;
  /** La langue originale du film, quand on la tient d'une source sûre. Voir `(VO)`. */
  originalLanguage?: string | null;
  /** Traductions : le mot « canaux », et « Piste N » quand rien d'autre ne nomme la piste. */
  canaux: (n: number) => string;
  piste: (n: number) => string;
}

/** La partie stable de l'étiquette — celle qui sert aussi à repérer les doublons. */
function base(track: AudioTrackFacts, options: LabelOptions): string {
  // La langue que le choix de piste lui prête, pas seulement son code : une piste sans code mais
  // titrée « French » était choisie comme française et affichée « Piste 2 » (23/09/2026).
  const code = trackLanguage(track);
  const langue = languageName(code, options.locale);
  const vo =
    langue && options.originalLanguage && code === normaliseLanguage(options.originalLanguage)
      ? " (VO)"
      : "";
  // « AD » colle à la langue : c'est une variante de cette langue, pas un format.
  const ad = isAudioDescription(track) ? " AD" : "";
  const region = variante(track.name);
  const codec = audioCodecName(track.codecId, track.profile);
  const morceaux = [
    langue ? `${langue}${region ? ` (${region})` : ""}${vo}${ad}` : null,
    codec && estRemarquable(codec) ? codec : null,
    channelLayout(track.channels, options.canaux),
  ].filter(Boolean);
  return morceaux.length > 0 ? morceaux.join(" — ") : options.piste(track.number);
}

/**
 * Ce qui distingue une piste d'une autre quand tout le reste est identique.
 *
 * Le titre brut, débarrassé de ce que l'étiquette dit déjà : « ENG VO : DDP 5.1 (Mix 6-Tracks
 * Original du LaserDisc) » devient « Mix 6-Tracks Original du LaserDisc ». S'il ne reste rien
 * d'utile, le numéro de piste tranche — il est laid, mais il est unique, et deux entrées
 * identiques dans un menu sont pires.
 */
function discriminant(track: AudioTrackFacts, options: LabelOptions): string {
  const brut = (track.name ?? "")
    /**
     * **`vff`, `vfq` et consorts ne sont pas retirés**, et c'est le correctif du 20/09/2026 :
     * ils étaient traités comme des marqueurs de langue alors qu'ils sont, dans ces fichiers, la
     * seule chose qui distingue les deux pistes. « La Fin d'Oak Street » affichait « (Piste 2) »
     * et « (Piste 3) » là où le fichier disait VFF et VFQ.
     *
     * Ils rejoignent désormais la langue quand on sait les nommer (voir `VARIANTES`) ; s'il en
     * reste un qu'on ne sait pas nommer, il vaut mieux l'afficher tel quel que l'effacer.
     */
    .replace(/\b(vo|eng|fra|fre|français|french|english|anglais)\b/gi, "")
    .replace(/\b(aac|e-?ac-?3|ddp|ac-?3|dts(-hd)?(\s*ma|\s*hra)?|truehd|flac|opus|atmos)\b/gi, "")
    .replace(/\b\d\.\d\b|\b(mono|st[ée]r[ée]o)\b/gi, "")
    // Les crochets et la ponctuation de structure s'en vont ; **les traits d'union internes
    // restent**, sinon « Mix 6-Tracks » devient « Mix 6 Tracks » et on abîme le seul texte qui
    // distingue encore les deux pistes.
    .replace(/[[\]():,]+/g, " ")
    .replace(/(^|\s)[-–—]+(\s|$)/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return brut.length > 2 ? brut : options.piste(track.number);
}

/**
 * Les étiquettes de toutes les pistes d'un fichier, désambiguïsées entre elles.
 *
 * Rendu pour l'ensemble et non piste par piste : savoir qu'une étiquette est ambiguë demande de
 * voir les autres. C'est la seule raison pour laquelle cette fonction prend un tableau.
 */
export function labelAudioTracks(tracks: AudioTrackFacts[], options: LabelOptions): { number: number; label: string }[] {
  const bases = tracks.map((track) => base(track, options));
  const compte = new Map<string, number>();
  for (const b of bases) compte.set(b, (compte.get(b) ?? 0) + 1);
  return tracks.map((track, i) => ({
    number: track.number,
    label: (compte.get(bases[i]) ?? 0) > 1 ? `${bases[i]} (${discriminant(track, options)})` : bases[i],
  }));
}


/**
 * Les sous-titres : **langue — type**, et le type est ce qu'on veut vraiment savoir.
 *
 * Choisir un sous-titre, c'est répondre à une question et une seule : est-ce qu'il traduit tout,
 * ou seulement ce que le film traite comme étranger ? Le reste — le format du fichier, SRT ou
 * ASS, interne ou externe — n'intéresse personne au moment de choisir, et c'est pourtant ce que
 * les titres bruts répètent : « FR Full : SRT » revient 137 fois dans cette bibliothèque.
 *
 *     Français — Forcés
 *     Français — Complets
 *     Anglais — Malentendants
 *     Français — Forcés (externe)
 *
 * Sur 855 pistes, 459 n'ont **aucun titre**. Le type ne peut donc pas venir du texte : il vient
 * des drapeaux du conteneur, et le titre ne sert que de repli — Jellyfin marque 112 pistes pour
 * malentendants là où le titre ne le dit que sur 85.
 */

export interface SubtitleTrackFacts extends NamedTrack {
  number: number;
  isHearingImpaired?: boolean;
  /** Un fichier posé à côté du film plutôt qu'une piste du conteneur. */
  isExternal?: boolean;
}

export interface SubtitleLabelOptions {
  locale: string;
  forces: string;
  complets: string;
  malentendants: string;
  externe: string;
  piste: (n: number) => string;
}

function typeSousTitre(track: SubtitleTrackFacts, options: SubtitleLabelOptions): string {
  // Les malentendants avant les forcés : une piste peut porter les deux drapeaux, et c'est la
  // description des sons qui change le plus ce qu'on voit à l'écran.
  if (track.isHearingImpaired || titleSaysHearingImpaired(track.name)) return options.malentendants;
  if (isForcedTrack(track)) return options.forces;
  return options.complets;
}

export function labelSubtitleTracks(
  tracks: SubtitleTrackFacts[],
  options: SubtitleLabelOptions
): { number: number; label: string }[] {
  const bases = tracks.map((track) => {
    const langue = languageName(trackLanguage(track), options.locale);
    const type = typeSousTitre(track, options);
    return langue ? `${langue} — ${type}` : `${options.piste(track.number)} — ${type}`;
  });
  const compte = new Map<string, number>();
  for (const b of bases) compte.set(b, (compte.get(b) ?? 0) + 1);

  return tracks.map((track, i) => {
    /**
     * L'origine ne s'affiche que lorsqu'elle départage.
     *
     * « Français — Forcés » et « Français — Forcés (externe) » côte à côte, c'est utile : ce sont
     * deux fichiers différents et l'un peut être meilleur que l'autre. Une piste externe seule de
     * sa langue n'a en revanche aucune raison d'annoncer d'où elle vient.
     */
    if ((compte.get(bases[i]) ?? 0) === 1) return { number: track.number, label: bases[i] };
    const detail = track.isExternal ? options.externe : discriminant(track, { ...options, canaux: () => "" });
    return { number: track.number, label: `${bases[i]} (${detail})` };
  });
}
