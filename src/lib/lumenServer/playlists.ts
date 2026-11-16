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
// - une variante par groupe audio (le CODECS d'une variante liste tous les formats des rendus de son
//   groupe, rfc8216bis §4.4.6.1.1) : un groupe par codec, et la même vidéo pour toutes ;
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
import { initName, playlistName, segmentName, type LumenAudioTrack, type LumenIndex, type LumenRendition } from "./format";
import { audioRendition } from "./audio/view";
import { targetDurationOf } from "./plan";

export interface MasterOptions {
  /** La piste que le spectateur ouvrirait : DEFAULT=YES dans son groupe, et sa variante en tête. */
  audioTrack: number | null;
  /** Les traductions et la langue de l'étiquette (`trackLabel.ts`). */
  labels: LabelOptions;
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
  const audio = servedAudio(index);
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
        codecId: a.converted ? "A_EAC3" : a.codecId,
        channels: a.converted ? a.converted.channels : a.channels,
        profile: a.signal?.channels.endsWith("/JOC") ? "Dolby Digital Plus + Dolby Atmos" : null,
      })),
      options.labels
    ).map((l) => [l.number, l.label])
  );

  // Un groupe par codec, dans l'ordre d'apparition ; le groupe de la piste choisie d'abord, pour que sa
  // variante soit la première listée — celle qu'un lecteur prend par défaut (1.32).
  const groups = new Map<string, LumenAudioTrack[]>();
  for (const a of audio) {
    const id = groupIdOf(a.signal!.codecs);
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
        `URI=${quoted(playlistName(audioRendition(a)))}`,
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
  if (order.length === 0) lines.push(variant(null, []));
  for (const id of order) lines.push(variant(id, [...new Set(groups.get(id)!.map((a) => a.signal!.codecs))]));
  return `${lines.join("\n")}\n`;
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
function seconds(us: number): string {
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
    lines.push(`#EXTINF:${seconds(s.endUs - s.startUs)},`, segmentName(rendition, n));
  });
  lines.push("#EXT-X-ENDLIST");
  return `${lines.join("\n")}\n`;
}
