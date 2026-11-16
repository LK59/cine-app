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
import { CONVERT_RATE, CONVERT_TARGETS, LUMEN_AUDIO_VERSION, targetFor, targetTag, type ConvertTarget } from "./convertGrid";

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
  return CONVERT_TARGETS.find((t) => t.id === id) ?? null;
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

/** Le rendu d'une piste tel que la liste le nomme : avec l'identité de sa conversion quand elle est convertie. */
export function audioRendition(track: Pick<LumenAudioTrack, "number" | "converted">): LumenRendition {
  return track.converted ? { kind: "audio", track: track.number, conv: track.converted.cid } : { kind: "audio", track: track.number };
}
