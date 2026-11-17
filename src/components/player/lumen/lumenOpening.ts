/**
 * Ce que `LumenServerHost` décide avant de poser une adresse sur l'élément (DECISIONS.md §180) — des
 * fonctions pures, parce que l'hôte ne se monte pas dans les empreintes : la piste d'ouverture, les numéros
 * de piste dans les deux espaces (Jellyfin et Matroska), les sous-titres du compte, la liste maître lue pour
 * relier le menu à `video.audioTracks`.
 *
 * **Deux espaces de numéros.** Le serveur de Lumen numérote les pistes comme le fichier (Matroska
 * `TrackNumber`, celui de la liste maître : `a{N}.m3u8`) ; Jellyfin, le lecteur serveur, les relais et les
 * intentions de rechargement parlent en index Jellyfin (`MediaStreams[].Index`). Le lien est le **rang**
 * parmi les pistes son, que les deux listent dans l'ordre du fichier — la règle de `jellyfinAudioIndex` du
 * lecteur actuel, et la même garde : des listes de longueurs différentes ne se relient pas (rien plutôt
 * qu'une autre langue).
 */
import type { LumenAudioFacts, LumenVerdict } from "@/lib/lumenServer/service";
import { chooseAudioTrack, chooseSubtitleTrack, trackLanguage, type TrackPreferences } from "@/lib/trackPreferences";
import { preferredOpeningTrack } from "@/lib/openingAudioChoice";
import type { ExternalSubtitleTrack } from "@/components/player/server/serverTracks";

export type { LumenAudioFacts, LumenVerdict };
import type { LumenDialogueMode } from "@/lib/lumenServer/audio/dialogue";
export type { LumenDialogueMode };

/** Une piste son du verdict, dans les termes du choix des pistes (`trackPreferences`). */
export interface LumenAudioChoice {
  number: number;
  language: string | null;
  name: string | null;
  isDefault: boolean;
  isForced: boolean;
  channels: number;
  servable: boolean;
  codec: string;
  /** Servie convertie (§161) : la cible (`eac3-640-51`), sinon null — copiée telle quelle. */
  converted: string | null;
  /** A ses rendus « Améliorer les dialogues » (§191) : leur cible, sinon null — le serveur ne la traite pas. */
  dialogue: string | null;
}

const layoutOf = (target: string) => (/-51$/.test(target) ? "5.1" : /-20$/.test(target) ? "2.0" : target);

/**
 * Ce que le serveur livre d'une piste, en mots, pour la ligne `audio` et le panneau : copiée, ou convertie et vers
 * quoi ; sous « Améliorer les dialogues » (§191), traitée par le serveur à cette force — ou copiée/convertie sans
 * traitement quand la piste n'a pas de rendu traité (la liste maître la sert alors telle quelle).
 */
export function processingOf(track: Pick<LumenAudioChoice, "codec" | "converted"> & Partial<Pick<LumenAudioChoice, "dialogue">>, dialogue?: LumenDialogueMode | null): string {
  if (dialogue && track.dialogue) return `dialogues ${dialogue === "strong" ? "davantage" : "améliorés"} par le serveur (${track.codec} → E-AC-3 ${layoutOf(track.dialogue)})`;
  const plain = track.converted ? `converti (${track.codec} → E-AC-3 ${layoutOf(track.converted)})` : "copié tel quel";
  return dialogue ? `${plain}, sans rendu « dialogues »` : plain;
}

export function audioChoicesOf(audio: readonly LumenAudioFacts[]): LumenAudioChoice[] {
  return audio.map((a) => ({
    number: a.number,
    // Le serveur écrit « und » pour une langue absente (la liste maître l'exige) : pour le choix, c'est une
    // absence, comme `normaliseLanguage` la lit.
    language: a.language && a.language !== "und" ? a.language : null,
    name: a.name,
    isDefault: a.isDefault,
    isForced: false,
    channels: a.channels,
    servable: a.servable,
    codec: a.codec,
    converted: a.converted ?? null,
    dialogue: a.dialogue ?? null,
  }));
}

/** Ce que Lumen serveur livre d'une piste : copiée telle quelle, à ses canaux (phase 1, sans conversion). */
const delivered = (t: LumenAudioChoice) => ({ channels: t.channels, copied: true });
const servable = (t: LumenAudioChoice) => t.servable;

export type OpeningAudio =
  | { kind: "ok"; number: number | null }
  /** La langue demandée n'existe qu'en piste que le serveur ne sert pas : le lecteur actuel la porte peut-être. */
  | { kind: "refus"; reason: string };

/**
 * La piste d'ouverture — la règle du lecteur actuel (`preferredOpeningTrack`), sur ce que le serveur sert.
 *
 * `chosen` : une piste déjà décidée (intention de rechargement, relais) — prise si le serveur la sert, sinon
 * refus : rouvrir dans une autre langue que celle que le spectateur vient de choisir serait pire qu'un détour
 * par le lecteur actuel. Sans elle : la préférence du compte. Si cette préférence désigne une langue que seule
 * une piste non servie porte (un DTS, un TrueHD — la conversion du son n'est pas encore là), refus aussi : le
 * lecteur actuel décode ces pistes dans la page, c'est lui qui donnera la bonne langue (l'écran du lecteur
 * actuel ferait de même : `chooseAudioTrack` sur toutes les pistes, puis bascule).
 */
export function openingAudioOf(
  audio: readonly LumenAudioChoice[],
  preferences: TrackPreferences | null,
  chosen: number | null
): OpeningAudio {
  if (audio.length === 0) return { kind: "ok", number: null };
  if (chosen !== null) {
    const track = audio.find((t) => t.number === chosen);
    if (track?.servable) return { kind: "ok", number: track.number };
    return { kind: "refus", reason: `piste choisie non servie (${track ? track.codec : `piste ${chosen} absente`})` };
  }
  if (preferences) {
    const wanted = chooseAudioTrack([...audio], preferences, servable, delivered);
    if (wanted && !wanted.servable) return { kind: "refus", reason: `piste de la langue du compte non servie (${wanted.codec})` };
  }
  const opening = preferredOpeningTrack(audio, servable, delivered, preferences);
  if (!opening?.servable) return { kind: "refus", reason: `aucune piste son servie (${opening?.codec ?? "?"})` };
  return { kind: "ok", number: opening.number };
}

/** Le rang de la piste `number` parmi les pistes son du fichier, ou -1. */
function rankOf(audio: readonly { number: number }[], number: number): number {
  return audio.findIndex((t) => t.number === number);
}

/** Un numéro Matroska → l'index Jellyfin (relais au lecteur serveur, intention de rechargement). */
export function jellyfinIndexOf(lumenAudio: readonly { number: number }[], jellyfinAudio: readonly { index: number }[] | undefined, number: number | null): number | undefined {
  if (number === null || !jellyfinAudio || jellyfinAudio.length !== lumenAudio.length) return undefined;
  const rank = rankOf(lumenAudio, number);
  return rank < 0 ? undefined : jellyfinAudio[rank]?.index;
}

/** Un index Jellyfin (`session.initialAudioStreamIndex`) → le numéro Matroska, ou null s'il ne se relie pas. */
export function matroskaNumberOf(lumenAudio: readonly { number: number }[], jellyfinAudio: readonly { index: number }[] | undefined, index: number | undefined): number | null {
  if (index === undefined || !jellyfinAudio || jellyfinAudio.length !== lumenAudio.length) return null;
  const rank = jellyfinAudio.findIndex((t) => t.index === index);
  return rank < 0 ? null : (lumenAudio[rank]?.number ?? null);
}

/**
 * Le sous-titre du compte à l'ouverture — la règle du lecteur actuel (`applyPreferences` :
 * `chooseSubtitleTrack` avec la langue **entendue**, forcés compris), sur les pistes **texte** que la route des
 * sous-titres convertit. Les pistes en images (PGS, VobSub) ne sont pas proposées : le lecteur actuel ne les
 * lit pas non plus, et un `<track>` vers leur conversion WebVTT resterait vide.
 */
export function openingSubtitleOf(
  tracks: readonly ExternalSubtitleTrack[],
  preferences: TrackPreferences | null,
  spoken: { language: string | null; name: string | null } | null
): number | null {
  if (!preferences) return null;
  const facts = tracks.map((st) => ({
    number: st.index,
    language: st.language ?? null,
    name: st.title ?? null,
    isDefault: st.isDefault,
    isForced: st.isForced ?? false,
  }));
  const spokenLanguage = spoken ? trackLanguage({ language: spoken.language, name: spoken.name, isDefault: false, isForced: false }) : null;
  return chooseSubtitleTrack(facts, preferences, spokenLanguage)?.number ?? null;
}

/** Les sous-titres qu'un `<track>` peut montrer : le texte seulement (`isText: false` = une piste en images). */
export function textSubtitles<T extends { isText?: boolean | null }>(tracks: readonly T[]): T[] {
  return tracks.filter((st) => st.isText !== false);
}

/** Une piste son telle que la liste maître la déclare (`EXT-X-MEDIA:TYPE=AUDIO`). */
export interface MasterAudio {
  number: number;
  name: string;
  language: string | null;
  group: string;
  isDefault: boolean;
}

function attributes(line: string): Map<string, string> {
  const out = new Map<string, string>();
  const re = /([A-Z0-9-]+)=("([^"]*)"|[^,]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line))) out.set(m[1], m[3] ?? m[2]);
  return out;
}

/**
 * Les pistes son de la liste maître (`playlists.ts` : un groupe par codec, `NAME` = l'étiquette de
 * `trackLabel.ts`, `URI` = `a{N}.m3u8` avec le numéro Matroska). C'est le seul lien sûr entre le menu et
 * `video.audioTracks`, dont Safari ne donne que `label` (le `NAME`) et `language` — et seulement pour le groupe
 * de la variante en cours.
 */
export function parseMasterAudio(text: string): MasterAudio[] {
  const out: MasterAudio[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith("#EXT-X-MEDIA:")) continue;
    const a = attributes(line.slice("#EXT-X-MEDIA:".length));
    if (a.get("TYPE") !== "AUDIO") continue;
    const uri = a.get("URI") ?? "";
    // `a12.m3u8`, convertie `a12x{cid}.m3u8` (§161), traitée `a12d1x{cid}.m3u8` (§191) ; l'essai du son multiplexé
    // (`vm12.m3u8`) n'a pas d'URI pour sa piste par défaut : sans numéro lisible, la piste n'est pas reliable — le
    // changement passera par la réouverture.
    const number = /(?:^|\/)a(\d+)(?:d[12])?(?:x[0-9a-f]{8})?\.m3u8$/.exec(uri)?.[1];
    if (!number) continue;
    const language = a.get("LANGUAGE") ?? null;
    out.push({ number: Number(number), name: a.get("NAME") ?? "", language: language && language !== "und" ? language : null, group: a.get("GROUP-ID") ?? "", isDefault: a.get("DEFAULT") === "YES" });
  }
  return out;
}

/** Ce que Safari expose d'une piste son (`AudioTrack`). */
export interface AudioTrackLike {
  label: string;
  language: string;
  enabled: boolean;
}

/**
 * La place de la piste `number` dans `video.audioTracks`, ou -1 quand Safari ne l'expose pas (autre groupe de
 * codec : une autre variante, que `enabled` ne sait pas choisir — le changement passe alors par le
 * rechargement). Par le `NAME` d'abord (unique dans la liste : `labelAudioTracks` départage les étiquettes
 * identiques) ; sinon par le rang dans le groupe, dans l'ordre de la liste maître, quand Safari expose
 * exactement ce groupe.
 */
export function audioTrackPosition(list: readonly AudioTrackLike[], master: readonly MasterAudio[], number: number): number {
  const target = master.find((m) => m.number === number);
  if (!target) return -1;
  const byName = list.findIndex((t) => t.label === target.name);
  if (byName >= 0) return byName;
  const group = master.filter((m) => m.group === target.group);
  if (group.length !== list.length) return -1;
  const rank = group.indexOf(target);
  const candidate = list[rank];
  if (!candidate) return -1;
  // Le rang seul ne suffit pas si la langue dit le contraire : mieux vaut un rechargement qu'une autre langue.
  if (target.language && candidate.language && candidate.language.slice(0, 2) !== target.language.slice(0, 2)) return -1;
  return rank;
}

/** La piste que Safari joue, en numéro Matroska — ou null s'il n'en dit rien. */
export function enabledAudioNumber(list: readonly AudioTrackLike[], master: readonly MasterAudio[]): number | null {
  const on = list.findIndex((t) => t.enabled);
  if (on < 0) return null;
  const byName = master.find((m) => m.name === list[on].label);
  return byName?.number ?? null;
}

/** Le verdict dit-il oui ? Une réponse inattendue se lit non, avec ce qu'elle dit. */
export function verdictRefusal(verdict: LumenVerdict | null | undefined): string | null {
  if (!verdict) return "réponse illisible";
  if (verdict.ok) return null;
  return "pending" in verdict ? "index en cours de construction" : `${verdict.reason}${verdict.detail ? ` : ${verdict.detail}` : ""}`;
}
