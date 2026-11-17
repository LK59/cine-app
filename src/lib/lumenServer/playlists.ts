// Les listes HLS de Lumen serveur : la liste maître et une liste média par piste.
//
// Écrites contre la « HLS Authoring Specification for Apple Devices » (révision du 26/06/2025 ; numéros
// de règle entre parenthèses) et draft-pantos-hls-rfc8216bis pour la syntaxe. `mediastreamvalidator`
// d'Apple ne tourne que sur macOS ; aucun validateur équivalent n'existe pour Linux (recherche du
// 16/11/2026 : muxinc/hlstools vise le MPEG-TS, les autres ne font que télécharger). Les règles sont
// donc vérifiées une à une par `lumenServer-playlists.test.ts`, et le banc fait relire les listes par le
// démultiplexeur HLS de ffmpeg, qui suit les URI relatives et l'EXT-X-MAP jusqu'au décodage.
//
// Liste maître :
// - **un seul groupe audio, tous codecs confondus** (format 5, DECISIONS §185), et donc une seule variante,
//   dont le CODECS liste tous les formats des rendus du groupe (rfc8216bis §4.4.6.2 : « every media format
//   in any of the renditions specified by the AUDIO attribute »). Avant (formats 1 à 4), un groupe par codec
//   et une variante par groupe : la forme des exemples d'Apple, mais Apple la complète en mettant **chaque
//   langue dans chaque groupe** (« Each group needs to have every language in it », annexe « Audio rendition
//   groups and variants » de la HLS Authoring Specification), et RFC 8216 §4.3.4.1.1 l'exige (« each Group
//   of the same TYPE MUST have the same set of members »). Nos groupes, eux, n'avaient pas les mêmes membres
//   (la VF en AC-3, la VO en E-AC-3) : passer de l'une à l'autre obligeait le lecteur à changer de variante
//   pour une sélection de piste, ce qu'Apple dit ne pas faire en général (« the player doesn't switch
//   between audio codecs », même annexe). Un seul groupe fait d'un changement de langue un changement de
//   rendu dans le groupe, comme entre deux pistes du même codec (mesuré : 1,6 à 1,9 s, §180). Un fichier
//   à un seul codec garde sa liste à l'octet près. L'ancienne forme reste un essai de `/lumen-test`
//   (`?groupes=codec`, `perCodecGroups`) ;
// - CODECS (9.1), RESOLUTION (9.2), AVERAGE-BANDWIDTH (9.14), FRAME-RATE (9.15), VIDEO-RANGE hors SDR
//   (9.16), SUPPLEMENTAL-CODECS pour un Dolby Vision 8.x — tirés de `hlsSignal.ts`, donc de l'init ;
// - LANGUAGE sur chaque rendu (8.10), NAME par `trackLabel.ts` (l'étiquette des deux lecteurs),
//   CHANNELS (« 16/JOC » pour un Atmos, 2.8), un seul DEFAULT=YES par groupe, AUTOSELECT=YES ;
// - EXT-X-INDEPENDENT-SEGMENTS (9.11) : chaque segment commence sur une image d'où l'on décode seul —
//   sous la découpe `idr` seulement. Sous `cra`/`cra-leading` (§157), un segment qui s'ouvre sur une CRA porte
//   des RASL qui se réfèrent au segment d'avant : la balise mentirait (rfc8216bis §4.4.2.1, « all media
//   samples in a Media Segment can be decoded without information from other segments »), elle n'est pas
//   écrite. Ce que Safari en fait est une des choses que la page `/lumen-test` mesure.
// Pas d'HDCP-LEVEL (13.5/13.6 sont des « SHOULD » pour du contenu protégé) : l'annoncer ferait refuser
// la variante à un écran sans HDCP, pour un flux qui n'est pas chiffré.
//
// Listes média : VOD, EXT-X-MAP vers l'init (8.20), EXTINF exacts au microsecondes, sur les MÊMES
// frontières pour la vidéo et chaque piste audio, même EXT-X-TARGETDURATION partout (8.2).

import { labelAudioTracks, type LabelOptions } from "@/lib/trackLabel";
import { normaliseLanguage } from "@/lib/trackPreferences";
import { variantCodecs } from "./hlsSignal";
import { initName, playlistName, segmentName, type LumenAudioTrack, type LumenIndex, type LumenLightRung, type LumenRendition } from "./format";
import { audioRendition, dialogueRendition } from "./audio/view";
import type { LumenDialogueMode } from "./audio/dialogue";
import { targetDurationOf } from "./plan";

export interface MasterOptions {
  /** La piste que le spectateur ouvrirait : DEFAULT=YES dans son groupe, et sa variante en tête. */
  audioTrack: number | null;
  /** Les traductions et la langue de l'étiquette (`trackLabel.ts`). */
  labels: LabelOptions;
  /**
   * L'essai `?groupes=codec` de `/lumen-test` : la forme des formats 1 à 4 — un groupe par codec, une variante
   * par groupe —, gardée pour mesurer contre la règle le changement de piste entre codecs (§185).
   */
  perCodecGroups?: boolean;
  /**
   * « Améliorer les dialogues » (§193, `?dialogue=on|strong`) : chaque piste qui a un rendu « dialogues » est servie
   * par lui **à la place** de son rendu ordinaire — même rang, même groupe, même nombre de rendus, l'URI, le `CODECS`
   * et les `CHANNELS` de ce qui est servi. Une piste sans ce rendu (AAC, FLAC…) garde le sien : l'hôte le sait par le
   * verdict (`dialogue` de chaque piste) et rend la lecture au lecteur actuel s'il la choisit.
   * Pas de rendus ajoutés à côté des autres : le menu de Safari (AirPlay, Lecture en cours) montrerait chaque piste
   * deux fois, et `audioTracks` ne se relierait plus au menu de la page par le rang. Sans `dialogue`, la liste est
   * celle d'avant, à l'octet près.
   */
  dialogue?: LumenDialogueMode;
  /**
   * La version allégée (`light/`) : les échelons de la vue (`withLight`), annoncés après la variante d'origine dans
   * chaque groupe son. `first` : cet échelon listé avant l'origine (une lecture qui démarre sur une connexion qu'on sait
   * faible : Safari prend la première variante) ; `only` : cet échelon seul (le banc). Absent ou vide : la liste
   * d'avant, à l'octet près.
   */
  light?: { rungs: LumenLightRung[]; first?: 1 | 2; only?: 1 | 2 };
}

/** Ce qu'une piste sert dans une liste maître : son rendu ordinaire, ou son rendu « dialogues » (§193). */
function servedAs(a: LumenAudioTrack, dialogue: LumenDialogueMode | undefined): { track: LumenAudioTrack; rendition: LumenRendition } {
  const processed = dialogue && a.dialogue ? dialogueRendition(a, dialogue) : null;
  if (!processed || !a.dialogue) return { track: a, rendition: audioRendition(a) };
  // Ce qui est servi : de l'E-AC-3 aux canaux de la cible — l'étiquette et la signalisation le disent, comme pour
  // une piste convertie (jamais « Atmos » : le JOC ne survit pas au décodage).
  return { track: { ...a, signal: a.dialogue.signal, converted: { target: a.dialogue.target, cid: a.dialogue.cids[dialogue!], channels: a.dialogue.channels } }, rendition: processed };
}

/** Une chaîne entre guillemets HLS : ni guillemet, ni retour à la ligne (rfc8216bis §4.2). */
function quoted(value: string): string {
  return `"${value.replace(/["\r\n]/g, (c) => (c === '"' ? "'" : " "))}"`;
}

function groupIdOf(codecs: string): string {
  return `aud-${codecs.replace(/[^A-Za-z0-9.+-]/g, "")}`;
}

/** Les pistes audio servies, dans l'ordre du fichier. */
export function servedAudio(index: LumenIndex): LumenAudioTrack[] {
  return index.audio.filter((a) => !a.refusal && a.signal && index.inits.audio[a.number]);
}

export function masterPlaylist(index: LumenIndex, options: MasterOptions): string {
  if (!index.video?.signal || index.segments.length === 0) throw new Error("Index sans vidéo servable.");
  const signal = index.video.signal;
  const served = new Map(servedAudio(index).map((a) => [a, servedAs(a, options.dialogue)] as const));
  const audio = [...served.values()].map((s) => s.track);
  const renditionOf = new Map([...served.values()].map((s) => [s.track, s.rendition] as const));
  const labels = new Map(
    labelAudioTracks(
      // L'Atmos se nomme d'après ce que le `dec3` écrit (« 16/JOC »), comme Jellyfin le nomme dans son
      // profil pour les autres lecteurs : la même étiquette partout.
      // Une piste convertie (§161) se nomme d'après ce qui est **servi** : de l'E-AC-3 5.1 ou 2.0, jamais
      // « TrueHD 7.1 » ni « Atmos » (l'Atmos d'une piste TrueHD est perdu, 5-conversion-son.md §5.2).
      audio.map((a) => ({
        number: a.number,
        language: a.language,
        name: a.name,
        isDefault: a.isDefault,
        isForced: a.isForced,
        // L'AAC d'un récepteur Chromecast (§192) se nomme en AAC ; l'E-AC-3 de §161 comme avant.
        codecId: a.converted ? (a.converted.target.startsWith("aac") ? "A_AAC" : "A_EAC3") : a.codecId,
        channels: a.converted ? a.converted.channels : a.channels,
        profile: a.signal?.channels.endsWith("/JOC") ? "Dolby Digital Plus + Dolby Atmos" : null,
      })),
      options.labels
    ).map((l) => [l.number, l.label])
  );

  // Un seul groupe, nommé d'après ses codecs (`aud-ec-3`, `aud-ac-3+ec-3`) : un fichier à un seul codec garde le
  // nom et la liste d'avant. L'essai `perCodecGroups` : un groupe par codec, dans l'ordre d'apparition ; le
  // groupe de la piste choisie d'abord, pour que sa variante soit la première listée — celle qu'un lecteur prend
  // par défaut (1.32).
  const groups = new Map<string, LumenAudioTrack[]>();
  const allCodecs = [...new Set(audio.map((a) => a.signal!.codecs))];
  for (const a of audio) {
    const id = options.perCodecGroups ? groupIdOf(a.signal!.codecs) : groupIdOf(allCodecs.join("+"));
    groups.set(id, [...(groups.get(id) ?? []), a]);
  }
  const chosen = audio.find((a) => a.number === options.audioTrack) ?? audio.find((a) => a.isDefault) ?? audio[0];
  const order = [...groups.keys()].sort((x, y) => Number(groups.get(y)!.includes(chosen!)) - Number(groups.get(x)!.includes(chosen!)));

  const lines = ["#EXTM3U", ...independentSegments(index)];
  for (const id of order) {
    const members = groups.get(id)!;
    // Un seul DEFAULT par groupe : la piste choisie, sinon celle que le fichier marque, sinon la première.
    const lead = members.includes(chosen!) ? chosen! : (members.find((a) => a.isDefault) ?? members[0]);
    for (const a of members) {
      const attributes = [
        "TYPE=AUDIO",
        `GROUP-ID=${quoted(id)}`,
        `LANGUAGE=${quoted(normaliseLanguage(a.language) ?? "und")}`,
        `NAME=${quoted(labels.get(a.number) ?? `${a.number}`)}`,
        `DEFAULT=${a === lead ? "YES" : "NO"}`,
        "AUTOSELECT=YES",
        `CHANNELS=${quoted(a.signal!.channels)}`,
        `URI=${quoted(playlistName(renditionOf.get(a) ?? audioRendition(a)))}`,
      ];
      lines.push(`#EXT-X-MEDIA:${attributes.join(",")}`);
    }
  }

  const peak = Math.max(index.bandwidth.peak, index.bandwidth.average, 1);
  const average = Math.max(index.bandwidth.average, 1);
  const frameRate = (index.frameRate > 0 ? index.frameRate : 1e6 / Math.max(1, index.frameUs)).toFixed(3);
  const variant = (audioGroup: string | null, audioCodecs: string[]): string => {
    const attributes = [
      `BANDWIDTH=${peak}`,
      `AVERAGE-BANDWIDTH=${average}`,
      `CODECS=${quoted(variantCodecs(signal, audioCodecs.map((codecs) => ({ codecs, channels: "" }))))}`,
    ];
    if (signal.supplementalCodecs) attributes.push(`SUPPLEMENTAL-CODECS=${quoted(signal.supplementalCodecs)}`);
    attributes.push(`VIDEO-RANGE=${signal.videoRange}`, `RESOLUTION=${index.video!.width}x${index.video!.height}`, `FRAME-RATE=${frameRate}`);
    if (audioGroup) attributes.push(`AUDIO=${quoted(audioGroup)}`);
    return `#EXT-X-STREAM-INF:${attributes.join(",")}\n${playlistName({ kind: "video" })}`;
  };
  // Un échelon de la version allégée : même groupe son, ses propres taille, codec et débits — honnêtes (ce que
  // l'encodeur vise et ne dépasse pas, plus la part du son), pour que Safari choisisse juste. Ni SUPPLEMENTAL-CODECS
  // (le Dolby Vision ne survit pas au réencodage) ; le même VIDEO-RANGE en 10 bits (PQ ou HLG gardé), SDR en 8 bits.
  const lightVariant = (rung: LumenLightRung, audioGroup: string | null, audioCodecs: string[]): string => {
    const light = { ...signal, codecs: rung.codecs, supplementalCodecs: null, videoRange: rung.tenBit ? signal.videoRange : ("SDR" as const) };
    const attributes = [
      `BANDWIDTH=${rung.peakBps + LIGHT_AUDIO_ALLOWANCE_BPS}`,
      `AVERAGE-BANDWIDTH=${rung.averageBps + LIGHT_AUDIO_ALLOWANCE_BPS}`,
      `CODECS=${quoted(variantCodecs(light, audioCodecs.map((codecs) => ({ codecs, channels: "" }))))}`,
      `VIDEO-RANGE=${light.videoRange}`,
      `RESOLUTION=${rung.width}x${rung.height}`,
      `FRAME-RATE=${frameRate}`,
    ];
    if (audioGroup) attributes.push(`AUDIO=${quoted(audioGroup)}`);
    return `#EXT-X-STREAM-INF:${attributes.join(",")}\n${playlistName({ kind: "light", rung: rung.rung, cid: rung.cid })}`;
  };
  // L'ordre des variantes : Safari démarre sur la première listée. L'origine d'abord (une bonne connexion démarre en
  // pleine qualité) ; un échelon d'abord quand la page sait sa connexion faible (`first`) ; un échelon seul pour le banc.
  const rungs = options.light?.rungs ?? [];
  const only = options.light?.only !== undefined ? rungs.filter((r) => r.rung === options.light!.only) : null;
  const firstRung = options.light?.first !== undefined ? rungs.find((r) => r.rung === options.light!.first) : undefined;
  const variantsFor = (id: string | null, codecs: string[]): string[] => {
    if (only) return only.map((r) => lightVariant(r, id, codecs));
    const rest = rungs.filter((r) => r !== firstRung).map((r) => lightVariant(r, id, codecs));
    return firstRung ? [lightVariant(firstRung, id, codecs), variant(id, codecs), ...rest] : [variant(id, codecs), ...rest];
  };
  if (order.length === 0) lines.push(...variantsFor(null, []));
  for (const id of order) lines.push(...variantsFor(id, [...new Set(groups.get(id)!.map((a) => a.signal!.codecs))]));
  return `${lines.join("\n")}\n`;
}

/**
 * La part du son dans les débits annoncés d'un échelon allégé : la piste la plus lourde que Lumen serveur sert (E-AC-3
 * Atmos à 768 kb/s) — un débit annoncé trop bas ferait choisir à Safari un échelon qui ne passe pas.
 */
export const LIGHT_AUDIO_ALLOWANCE_BPS = 768_000;

/**
 * La liste maître servie à un récepteur Chromecast (`cc.{jeton}`, DECISIONS.md §192), à part de celle de la page : la
 * même forme, sur la vue `castView` (le son en AAC), avec **une seule piste son** — celle demandée (`?audio=N`) — et
 * sans `SUPPLEMENTAL-CODECS`.
 * - Une piste : le lecteur de Google choisit son rendu par `DEFAULT` (« AUTOSELECT n'est pas utilisé »), mais une
 *   seule piste ne laisse aucun doute, et chaque autre piste convertie qu'il irait chercher coûterait une conversion.
 *   Un changement de piste est un nouveau chargement depuis la page (la télécommande, §64), comme avec Jellyfin.
 * - Pas de `SUPPLEMENTAL-CODECS` : un Dolby Vision 8 se lit par sa couche de base (`hvc1`), et un attribut que le
 *   lecteur du récepteur ne connaît pas n'a rien à y gagner.
 * La liste de la page (`masterPlaylist`) n'est pas touchée : ses octets restent ceux de §185.
 */
export function castMasterPlaylist(index: LumenIndex, options: Pick<MasterOptions, "audioTrack" | "labels">): string {
  const served = servedAudio(index);
  const chosen = served.find((a) => a.number === options.audioTrack) ?? served.find((a) => a.isDefault) ?? served[0];
  const video = index.video?.signal ? { ...index.video, signal: { ...index.video.signal, supplementalCodecs: null } } : index.video;
  const only: LumenIndex = { ...index, video, audio: chosen ? [chosen] : [] };
  return masterPlaylist(only, { audioTrack: chosen?.number ?? null, labels: options.labels });
}

/**
 * EXT-X-INDEPENDENT-SEGMENTS sous la seule découpe qui le garantit, `idr` (chaque coupe lue). Sous la règle
 * `cra` (§158), un segment peut s'ouvrir sur une CRA dont les RASL se réfèrent au segment d'avant, et
 * l'index des Cues ne lit pas les clés : même un fichier à IDR seules ne le prouve pas. Le banc Safari du
 * 16/11/2026 a joué *Black Monday* (IDR seules) avec et sans la balise : aucune différence.
 */
function independentSegments(index: LumenIndex): string[] {
  return index.cut === "idr" ? ["#EXT-X-INDEPENDENT-SEGMENTS"] : [];
}

/** Une durée en secondes, au microseconde, sans zéros inutiles : `4.004`, `10.427083`. */
export function extinfSeconds(us: number): string {
  return (us / 1e6).toFixed(6).replace(/\.?0+$/, "") || "0";
}

/** La liste média d'une piste : mêmes segments, mêmes durées pour toutes. */
export function mediaPlaylist(index: LumenIndex, rendition: LumenRendition): string {
  if (index.segments.length === 0) throw new Error("Index sans segments.");
  const lines = [
    "#EXTM3U",
    "#EXT-X-VERSION:7",
    `#EXT-X-TARGETDURATION:${targetDurationOf(index.segments)}`,
    "#EXT-X-MEDIA-SEQUENCE:0",
    "#EXT-X-PLAYLIST-TYPE:VOD",
    ...independentSegments(index),
    `#EXT-X-MAP:URI=${quoted(initName(rendition))}`,
  ];
  index.segments.forEach((s, n) => {
    lines.push(`#EXTINF:${extinfSeconds(s.endUs - s.startUs)},`, segmentName(rendition, n));
  });
  lines.push("#EXT-X-ENDLIST");
  return `${lines.join("\n")}\n`;
}
