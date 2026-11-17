// La vue d'un index quand la conversion du son est en service (DECISIONS.md §161).
//
// L'index d'un fichier (`lumenIndex.ts`) ne dépend que du fichier : il est gardé sur le disque, partagé entre les
// comptes, et ne sait rien d'une option ni de ffmpeg. Une piste DTS, TrueHD, Opus ou MP2/MP3 y reste refusée
// (`son-codec`) avec ses faits de conversion (`convert`). Cette vue, calculée à chaque requête — quelques objets,
// l'init gardé —, rend la même piste **servable convertie** quand la conversion est permise à cette requête (option
// ouverte au compte, ffmpeg détecté conforme) : refus levé, signalisation `ec-3` décrite depuis la trame de
// référence de la cible, init construit, rendu nommé avec l'identité de la conversion. Sans conversion permise,
// la vue **est** l'index : rien ne change, à l'octet près, pour une instance qui n'a pas l'option ou pas ffmpeg.
//
// Code pur : la trame de référence et l'identité viennent de l'appelant (`conversion.ts`, la détection).

import { createHash } from "node:crypto";
import { audioSampleEntryFor } from "../../webcodecs/mp4SampleEntries";
import { initSegment } from "../../webcodecs/mp4Muxer";
import type { MatroskaTrack } from "../../webcodecs/matroska";
import { hlsAudioSignal } from "../hlsSignal";
import { AUDIO_TRACK_ID, LUMEN_TIMESCALE, type LumenAudioTrack, type LumenIndex, type LumenRendition } from "../format";
import { ALL_TARGETS, AAC_GRID, CONVERT_RATE, LUMEN_AUDIO_VERSION, TARGET_CAST_AAC, targetFor, targetTag, type ConvertTarget } from "./convertGrid";
import { convertSourceOf, type LumenConvertSource } from "./convertSource";

/** Ce qu'une requête apporte pour convertir : l'identité du binaire et une trame de référence par cible. */
export interface ConversionContext {
  ffmpegVersion: string;
  ffmpegSha256: string;
  reference: Readonly<Record<string, Uint8Array>>;
}

/**
 * L'identité d'une conversion, huit chiffres hexadécimaux : la version des règles (`LUMEN_AUDIO_VERSION`), la
 * cible et ses réglages, la version et l'empreinte de ffmpeg. Dans le nom des rendus convertis et dans la clé du
 * cache : un autre binaire (une autre construction, un autre chemin SIMD) est une autre adresse.
 */
export function conversionId(ctx: Pick<ConversionContext, "ffmpegVersion" | "ffmpegSha256">, target: ConvertTarget): string {
  return createHash("sha256").update(`${LUMEN_AUDIO_VERSION}|${targetTag(target)}|${ctx.ffmpegVersion}|${ctx.ffmpegSha256}`).digest("hex").slice(0, 8);
}

/** La cible d'une piste convertie, par son identifiant. */
export function targetById(id: string): ConvertTarget | null {
  return ALL_TARGETS.find((t) => t.id === id) ?? null;
}

const INITS = Symbol.for("cine-app.lumenServer.convertedInits");

/** L'init d'un rendu converti : quelques centaines d'octets, gardés par (version du fichier, piste, conversion). */
function convertedInit(index: LumenIndex, track: LumenAudioTrack, target: ConvertTarget, reference: Uint8Array, cid: string): Uint8Array {
  const g = globalThis as unknown as Record<symbol, Map<string, Uint8Array> | undefined>;
  const memo = (g[INITS] ??= new Map());
  const key = `${index.identity.path}|${index.identity.mtimeMs}|${index.identity.size}|${index.durationUs}|${track.number}|${cid}|${track.language ?? ""}`;
  const held = memo.get(key);
  if (held) return held;
  const init = initSegment(
    {
      id: AUDIO_TRACK_ID,
      kind: "audio",
      timescale: LUMEN_TIMESCALE,
      // Le `dec3` décrit la trame de référence de la cible : `fscod`, `bsid`, `bsmod`, `acmod`, `lfeon` et le débit
      // ne dépendent que des réglages de l'encodeur, identiques pour chaque trame qu'il produit (vérifié trame par
      // trame à la conversion, `checkTargetFrame`).
      sampleEntry: audioSampleEntryFor({ codecId: "A_EAC3", codecPrivate: null, channels: target.channels, sampleRate: CONVERT_RATE, firstFrame: reference }, { signalling: "hls" }),
      width: 0,
      height: 0,
      language: track.language ?? "und",
    },
    index.durationUs / 1e6
  );
  memo.set(key, init);
  while (memo.size > 2000) memo.delete(memo.keys().next().value!);
  return init;
}

/**
 * L'index tel que le sert une requête : avec ses pistes convertibles servies converties si `ctx` est donné, l'index
 * lui-même sinon. Une piste déjà servable (copiée) ne change jamais ; une piste refusée pour une autre raison que
 * son codec reste refusée.
 */
export function withConversion(index: LumenIndex, ctx: ConversionContext | null): LumenIndex {
  if (!ctx || index.refusal) return index;
  if (!index.audio.some((a) => a.convert && a.refusal?.reason === "son-codec")) return index;
  const inits = { ...index.inits.audio };
  const audio = index.audio.map((a): LumenAudioTrack => {
    if (!a.convert || a.refusal?.reason !== "son-codec") return a;
    const target = targetFor(a.convert.channels);
    const reference = ctx.reference[target.id];
    if (!reference) return a;
    const fake = { codecId: "A_EAC3", codecPrivate: null, audio: { channels: target.channels, sampleRate: CONVERT_RATE } } as unknown as MatroskaTrack;
    const signal = hlsAudioSignal(fake, reference);
    if (!signal) return a;
    const cid = conversionId(ctx, target);
    inits[a.number] = convertedInit(index, a, target, reference, cid);
    return { ...a, refusal: null, signal, converted: { target: target.id, cid, channels: target.channels } };
  });
  return { ...index, audio, inits: { ...index.inits, audio: inits } };
}

// ── La vue d'un récepteur Chromecast (DECISIONS.md §192) ─────────────────────

/**
 * La source à convertir d'une piste pour un récepteur : ses faits de conversion de l'index (DTS, TrueHD, Opus, MP2/MP3),
 * ou, pour une AC-3/E-AC-3 copiable, ceux que la chaîne du banc sait déjà tirer de sa première trame (`convertSourceOf`,
 * `dolby` — la VF E-AC-3 de *Braveheart* y passe à 0 échantillon de sa copie, §161). Rien n'est ajouté à l'index (aucun
 * changement de `LUMEN_FORMAT_VERSION`) : ces faits se recalculent à la requête depuis la trame gardée. Null : FLAC,
 * PCM, MP4, une piste sans première trame — le récepteur garde alors le flux de Jellyfin.
 */
function castSourceOf(index: LumenIndex, track: LumenAudioTrack): LumenConvertSource | null {
  if (track.convert) return track.convert;
  if (track.codecId !== "A_AC3" && track.codecId !== "A_EAC3") return null;
  const verdict = convertSourceOf(
    { codecId: track.codecId, codecPrivate: track.codecPrivate, channels: track.channels, sampleRate: track.sampleRate },
    // Une piste plus courte que l'image : au-delà de son silence de queue (§159), plus rien à lire.
    { firstUs: track.firstUs, firstFrame: track.firstFrame, lastBlockUs: track.silence?.tailFromUs ?? null },
    index.container,
    { cast: true }
  );
  return verdict.ok ? verdict.source : null;
}

const CAST_INITS = Symbol.for("cine-app.lumenServer.castInits");

/** L'init d'un rendu AAC de récepteur : `mp4a` + `esds` de la configuration constante, à l'échelle de 48 000 (`AAC_GRID`). */
function castAacInit(index: LumenIndex, track: LumenAudioTrack, configuration: Uint8Array, cid: string): Uint8Array {
  const g = globalThis as unknown as Record<symbol, Map<string, Uint8Array> | undefined>;
  const memo = (g[CAST_INITS] ??= new Map());
  const key = `${index.identity.path}|${index.identity.mtimeMs}|${index.identity.size}|${index.durationUs}|${track.number}|${cid}|${track.language ?? ""}`;
  const held = memo.get(key);
  if (held) return held;
  const init = initSegment(
    {
      id: AUDIO_TRACK_ID,
      kind: "audio",
      timescale: AAC_GRID.timescale,
      sampleEntry: audioSampleEntryFor({ codecId: "A_AAC", codecPrivate: configuration, channels: TARGET_CAST_AAC.channels, sampleRate: CONVERT_RATE, firstFrame: null }, { signalling: "hls" }),
      width: 0,
      height: 0,
      language: track.language ?? "und",
    },
    index.durationUs / 1e6
  );
  memo.set(key, init);
  while (memo.size > 2000) memo.delete(memo.keys().next().value!);
  return init;
}

/** Les profils H.264 qu'un Chromecast décode : Baseline, Main, Extended, High — jamais High 10, 4:2:2 ni 4:4:4. */
const CAST_AVC_PROFILES = new Set([66, 77, 88, 100]);

/** Pourquoi la vidéo d'un index ne va pas à un récepteur, ou null. */
export function castVideoRefusal(index: LumenIndex): string | null {
  const signal = index.video?.signal;
  if (!signal) return null; // déjà refusé par l'index
  // Une entrée `dvh1` (Dolby Vision sans base compatible) : aucun récepteur de Google ne la lit par MediaSource.
  if (signal.entry === "dvh1") return "chromecast : Dolby Vision sans couche compatible";
  if (signal.entry === "avc1") {
    const profile = parseInt(signal.codecs.slice(5, 7), 16);
    if (!CAST_AVC_PROFILES.has(profile)) return `chromecast : H.264 profil ${profile}`;
  }
  return null;
}

/** La famille de la vidéo servie, pour l'émetteur : il ne propose le HEVC qu'à un récepteur qui ne l'a pas refusé. */
export function castVideoFamily(index: LumenIndex): "h264" | "hevc" | null {
  const entry = index.video?.signal?.entry;
  if (entry === "avc1") return "h264";
  if (entry === "hvc1" || entry === "hvc1+dv") return "hevc";
  return null;
}

/**
 * L'index tel que le sert l'adresse d'un récepteur Chromecast (`cc.{jeton}`), depuis l'index **brut** (sans la vue de
 * §161) :
 * - un AAC copiable reste copié, aux mêmes octets que pour la page (son rendu s'appelle `a{N}`) ;
 * - toute autre piste dont on sait la source (DTS, TrueHD, Opus, MP2/MP3, AC-3, E-AC-3) est **convertie en AAC-LC
 *   stéréo** (`TARGET_CAST_AAC`) quand la conversion est permise à la requête (`ctx` : l'option `LUMEN_AUDIO_CONVERT`
 *   ouverte au compte, ffmpeg conforme avec son encodeur AAC) — un rendu `a{N}x{cid}`, une autre identité de conversion
 *   que l'E-AC-3, donc d'autres adresses et d'autres clés de cache ;
 * - le reste est refusé `son-codec` (« chromecast : … »), et le verdict de cette piste renvoie le récepteur au flux de
 *   Jellyfin.
 * La vidéo n'est pas touchée (mêmes init et segments que la page) ; une vidéo qu'aucun récepteur ne lit est refusée
 * (`castVideoRefusal`). Le Dolby Vision 8 garde son `dvvC` dans l'init : un récepteur lit la couche de base (HDR10 ou SDR).
 */
export function castView(raw: LumenIndex, ctx: ConversionContext | null): LumenIndex {
  if (raw.refusal) return raw;
  const videoRefusal = castVideoRefusal(raw);
  if (videoRefusal) return { ...raw, refusal: { reason: "video-codec", detail: videoRefusal } };
  const aac = ctx?.reference[TARGET_CAST_AAC.id] ?? null;
  const cid = ctx && aac ? conversionId(ctx, TARGET_CAST_AAC) : null;
  const inits: Record<number, Uint8Array> = {};
  const audio = raw.audio.map((a): LumenAudioTrack => {
    if (a.codecId === "A_AAC" && !a.refusal && raw.inits.audio[a.number]) {
      inits[a.number] = raw.inits.audio[a.number];
      return a;
    }
    const source = aac && cid ? castSourceOf(raw, a) : null;
    // Une piste refusée pour une autre raison que son codec (son en retard sans silence possible, fréquence…) n'est pas
    // reprise ici : la conversion la placerait (zéros devant, derrière), mais ce chemin n'a pas été mesuré.
    const reusable = !a.refusal || a.refusal.reason === "son-codec";
    if (!source || !reusable || !aac || !cid) {
      return { ...a, refusal: { reason: "son-codec", detail: `chromecast : ${a.codecId} (AAC seulement${aac ? "" : ", conversion coupée"})` }, signal: null, converted: undefined };
    }
    inits[a.number] = castAacInit(raw, a, aac, cid);
    return {
      ...a,
      refusal: null,
      convert: source,
      signal: { codecs: "mp4a.40.2", channels: String(TARGET_CAST_AAC.channels) },
      converted: { target: TARGET_CAST_AAC.id, cid, channels: TARGET_CAST_AAC.channels },
    };
  });
  return { ...raw, audio, inits: { ...raw.inits, audio: inits } };
}

/** Le rendu d'une piste tel que la liste le nomme : avec l'identité de sa conversion quand elle est convertie. */
export function audioRendition(track: Pick<LumenAudioTrack, "number" | "converted">): LumenRendition {
  return track.converted ? { kind: "audio", track: track.number, conv: track.converted.cid } : { kind: "audio", track: track.number };
}
