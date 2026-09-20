// Which way to play this file, and why.
//
// There are two working paths and they are not equivalent. Ranking them here, in one place, keeps
// the reasoning out of the player and makes the choice something that can be shown to the viewer
// rather than guessed at from the symptoms.
//
//   1. Remux to fragmented MP4 and hand it to a real <video>.
//      The browser decodes in hardware, composites the picture itself, drives its own audio
//      clock, and displays HDR natively. No pixel and no audio sample passes through JavaScript.
//      This is better on every axis that matters — battery, heat, smoothness, colour — and the
//      only reason it is not the sole path is that it can only carry codecs the browser accepts.
//
//   2. Decode with WebCodecs and paint a canvas.
//      Works where the first cannot: an audio codec the browser will not accept in an MP4 but
//      that can be decoded in software, or a container the remuxer does not handle. It costs a
//      per-frame JavaScript loop, tone mapping in a shader for HDR, and a hand-run audio clock.
//
//   3. Neither. Say so, name the codec, and stop.
//
// What is deliberately absent is a silent fallback. A player that quietly drops from the first
// path to the second looks like it works and hides that the good path never ran — which is
// exactly how a performance problem stays invisible for months.

import type { ByteSource } from "./byteSource";
import { unsupportedReason, dolbyVisionInfo } from "./codecConfig";
import type { MatroskaFile, MatroskaTrack } from "./matroska";
import { canRebuildAudioBuffer, playabilityOf } from "./mseSource";
import { trace } from "./trace";
import { chooseTranscodePlan, chooseTranscodeCodec } from "./audioTranscode";
import {
  Remuxer,
  audioDelivery,
  plannedMimeTypes,
  playableAudio,
  remuxableVideo,
  setAudioBufferRebuildable,
  type RemuxPlan,
} from "./remuxer";

/**
 * Whether a browser saying yes to replacing an audio buffer is believed.
 *
 * It is not, and the measurement is why. Safari accepts `removeSourceBuffer` followed by
 * `addSourceBuffer`, accepts every segment appended to the new buffer, and grows its ranges
 * exactly as it should — and plays no sound at all from it. The next seek then closes the
 * MediaSource with "media failed to decode". The API works; what it produces does not.
 *
 * So the answer is measured and written into the record, and the player behaves as though it were
 * no: a file whose tracks cannot all be delivered as they are has all of them re-encoded, decided
 * once when it is opened, and the audio codec never changes for the life of the MediaSource. That
 * costs a bit-exact AC-3 track on a file that mixes codecs, and buys a player that does not stop.
 *
 * Left switchable rather than deleted: the probe still says what the browser claims, so the day
 * one of them means it, this is one line.
 */
const TRUST_BUFFER_REBUILD = false;

/** Placeholder for the playability probe, which only ever reads the MIME strings. */
const EMPTY = new Uint8Array(0);

export type PlaybackPathName = "remux" | "webcodecs";

export interface PathAttempt {
  path: PlaybackPathName;
  ok: boolean;
  /** Why this path was not taken. Shown in the technical panel, never swallowed. */
  reason?: string;
}

export interface ChosenPath {
  path: PlaybackPathName;
  /** Present only when the chosen path is the remux one. */
  remuxer: Remuxer | null;
  plan: RemuxPlan | null;
  /** Every path considered, in rank order, with the reason each was rejected. */
  attempts: PathAttempt[];
}

export interface PathInput {
  source: ByteSource;
  file: MatroskaFile;
  videoTrack: MatroskaTrack;
  audioTrack: MatroskaTrack | null;
  dimensions: { width: number; height: number };
  /** Ce que le serveur sait de la plage dynamique — voir `RemuxPlaybackOptions.videoRangeType`. */
  videoRangeType?: string | null;
}

/**
 * **L'interrupteur du Dolby Vision.**
 *
 * Même rôle et même raison d'être que `TRUST_BUFFER_REBUILD` quelques lignes plus bas : la sonde
 * tourne, sa réponse est écrite dans le journal, et ce drapeau décide si on la croit.
 *
 * À `false`, le remultiplexeur écrit `hvc1` comme il l'a toujours fait et les 188 titres Dolby
 * Vision de cette bibliothèque continuent d'être lus en HDR10 — c'est-à-dire correctement. Un
 * doute sur une image se lève donc en changeant un mot, pas en défaisant un lot de commits.
 *
 * Il est à `true` parce que trois mesures le justifient, prises sur un iPhone le 19/09/2026 : le
 * témoin d'un profil inexistant est refusé (donc le numéro est validé), l'enregistrement est bien
 * dans le conteneur (donc on recopie au lieu de fabriquer), et la chaîne construite depuis un
 * vrai fichier est acceptée. Ce qu'aucune des trois ne prouve, c'est que l'image soit juste — un
 * `isTypeSupported` satisfait n'a jamais promis un rendu. Seul un œil sur une scène sombre le dira.
 */
const TRUST_DOLBY_VISION = true;

/**
 * Ce qu'on fait d'une piste qui porte du Dolby Vision, en trois issues et pas une de plus.
 *
 * L'ordre est celui que le foyer a demandé : le Dolby Vision quand tout s'y prête, sa couche de
 * base sinon, et le serveur quand il n'y a pas de couche de base du tout.
 *
 * Fonction pure, et c'est délibéré : c'est la seule partie de ce chantier où une erreur de
 * raisonnement ne se verrait pas à la lecture, donc c'est celle qu'il faut pouvoir éprouver sans
 * navigateur, sans fichier et sans appareil.
 */
export type DolbyVisionPlan =
  | { kind: "dolby"; codec: string; box: { type: string; record: Uint8Array } }
  | { kind: "hdr10" }
  | { kind: "server"; reason: string };

/**
 * Le Dolby Vision se porte dans une entrée `dvh1`, qui est de la famille HEVC — et seulement elle.
 *
 * Trouvé en balayant la bibliothèque une heure après avoir livré ce chantier, et jamais en
 * relisant le code : « Marty Supreme » est en **AV1** avec un Dolby Vision profil 10. Le record
 * est là, lisible, et produit une chaîne parfaitement formée — `dvh1.10.08`. Elle est pourtant
 * fausse : `dvh1` annonce du HEVC, alors que l'entrée écrite pour une piste AV1 est `av01`. Le
 * type déclaré et la boîte écrite se seraient contredits, et le segment d'initialisation aurait
 * été rejeté en bloc : un film qui marchait serait devenu injouable.
 *
 * L'AV1 a sa propre forme — `dav1` — et c'est un autre chantier, pour un seul fichier. En
 * attendant, ce fichier reprend exactement le chemin qu'il avait hier : sa couche de base, qui
 * est du HDR10 (compatibilité 1), lue par le chemin natif comme n'importe quel HDR.
 */
const DOLBY_VISION_CODECS = new Set(["V_MPEGH/ISO/HEVC"]);

export function planDolbyVision(
  track: Pick<MatroskaTrack, "dolbyVision" | "codecId">,
  videoRangeType: string | null | undefined,
  accepts: (mimeType: string) => boolean,
  trusted = TRUST_DOLBY_VISION
): DolbyVisionPlan {
  // « DOVI » tout court est la seule plage sans couche de base : le profil 5, dont la couche est
  // en IPT-PQ. Tout le reste — DOVIWithHDR10, DOVIWithSDR, HDR10, SDR… — se lit correctement sans
  // Dolby Vision, et c'est ce qui rend un refus sans conséquence.
  const noBaseLayer = videoRangeType === "DOVI";
  const dv = DOLBY_VISION_CODECS.has(track.codecId) ? track.dolbyVision : undefined;
  const info = dv ? dolbyVisionInfo(dv.record) : null;

  if (trusted && dv && info && accepts(`video/mp4; codecs="${info.codec}"`)) {
    return { kind: "dolby", codec: info.codec, box: dv };
  }
  if (!noBaseLayer) return { kind: "hdr10" };
  return {
    kind: "server",
    reason: `Le Dolby Vision sans couche HDR10 n'a pas de base standard : ce lecteur en rendrait les couleurs fausses.`,
  };
}

/**
 * Un refus qui ne vise pas le remultiplexage, mais **ce lecteur**.
 *
 * Presque tous les refus de `tryRemux` disent « pas par ce chemin-là », et le chemin canevas prend
 * la suite. Celui du Dolby Vision sans couche de base ne dit pas cela : il dit que le fichier n'a
 * aucune image juste à offrir ici, canevas compris, et qu'il faut le lecteur serveur.
 *
 * La distinction manquait, et le journal l'a montrée le 20/09/2026. « Disclosure Day » sur Chrome :
 * le remultiplexage refuse en annonçant « passage au lecteur serveur », le canevas est essayé
 * quand même, décode, puis échoue à convertir l'image — deux tentatives perdues avant le repli
 * qu'on avait déjà décidé. La trace disait la bonne chose, le code faisait l'autre.
 */
interface NoLocalPath {
  reason: string;
  server: true;
}

/** Why the remux path cannot carry this file, or null if it can. */
async function tryRemux(input: PathInput): Promise<{ remuxer: Remuxer; plan: RemuxPlan } | string | NoLocalPath> {
  const { file, videoTrack, audioTrack, dimensions, source } = input;

  trace(`chemin : examen du remultiplexage — vidéo ${videoTrack.codecId}, audio ${audioTrack?.codecId ?? "aucune"}`);

  // Asked first, because everything below names the codec a re-encoded track will be delivered
  // as, and only the browser knows what it can both produce and take back.
  if (audioTrack) {
    await chooseTranscodeCodec(audioTrack.audio?.sampleRate ?? 48000, audioTrack.audio?.channels ?? 2);
  }

  // Asked, recorded, and then not acted on — see TRUST_BUFFER_REBUILD.
  const video = plannedMimeTypes(videoTrack, null).video;
  if (video) {
    const rebuildable = await canRebuildAudioBuffer(video);
    setAudioBufferRebuildable(rebuildable && TRUST_BUFFER_REBUILD);
    trace(
      `chemin : ce navigateur ${rebuildable ? "accepte" : "refuse"} de remplacer le tampon audio à chaud` +
        (rebuildable && !TRUST_BUFFER_REBUILD ? " (mesuré inexploitable, non utilisé)" : "")
    );
  }
  if (!remuxableVideo(videoTrack)) return `vidéo ${videoTrack.codecId} non remultiplexable`;
  if (audioTrack && !playableAudio(audioTrack)) return `audio ${audioTrack.codecId} non remultiplexable`;

  // Asked before a megabyte and a half of decoder is fetched. A track that has to be re-encoded
  // is only carried here if this browser will do the encoding, and finding that out afterwards
  // would mean paying for the download to learn it.
  if (audioTrack && audioDelivery(audioTrack, file) === "transcode") {
    const rate = audioTrack.audio?.sampleRate ?? 48000;
    const channels = audioTrack.audio?.channels ?? 2;
    trace(`chemin : ${audioTrack.codecId} doit être ré-encodé, on cherche un codec en ${channels} canaux`);
    const plan = await chooseTranscodePlan(rate, channels);
    if (!plan) {
      return `ce navigateur n'accepte pas ${audioTrack.codecId} et ne sait produire aucun codec de remplacement`;
    }
    // Le codec retenu, pas celui qu'on aurait préféré : l'AAC vient en premier dans la liste des
    // candidats, mais un navigateur qui ne sait pas l'encoder en multicanal repart avec l'Opus, et
    // un relevé qui annonce l'AAC pour finir sur l'Opus laisse chercher une contradiction qui
    // n'existe pas.
    trace(`chemin : codec de remplacement retenu — ${plan.codec} en ${plan.channels} canaux`);
    if (plan.channels !== channels) {
      // Deux canaux d'ambiance en moins valent mieux que le chemin canevas, qui décode un 4K HDR
      // en logiciel et, sur une source Dolby Vision, ne sait pas convertir l'image.
      trace(`chemin : ${channels} canaux non encodables ici, la piste sera livrée en ${plan.channels}`);
    }
  }

  // Asked before anything is opened. Describing an AC-3 track means reading a frame out of the
  // file, and there is no reason to pay for that only to be told the browser wanted none of it.
  const mime = plannedMimeTypes(videoTrack, audioTrack, file);
  const playable = playabilityOf({
    videoMimeType: mime.video ?? "",
    audioMimeType: mime.audio,
    videoInit: EMPTY,
    audioInit: null,
    durationSeconds: 0,
  });
  trace(`chemin : le navigateur accepte-t-il ${mime.video ?? "?"} + ${mime.audio ?? "aucun"} → ${playable.ok ? "oui" : "non"}`);
  if (!playable.ok) return playable.reason;

  /**
   * Le Dolby Vision, décidé ici parce que c'est ici qu'on sait demander au navigateur.
   *
   * La question posée est complète — l'image *et* le son —, comme celle du dessus : un navigateur
   * peut accepter `dvh1` seul et refuser l'assemblage. Et la réponse est écrite dans le journal
   * quoi qu'il arrive, y compris quand l'interrupteur est fermé : savoir ce qu'on aurait pu faire
   * vaut mieux que ne rien noter.
   */
  const dv = planDolbyVision(videoTrack, input.videoRangeType, (videoMimeType) =>
    playabilityOf({ videoMimeType, audioMimeType: mime.audio, videoInit: EMPTY, audioInit: null, durationSeconds: 0 }).ok
  );
  if (videoTrack.dolbyVision) {
    const detail =
      dv.kind === "dolby"
        ? `livré en ${dv.codec}`
        : dv.kind === "hdr10"
          ? "refusé ou non demandé — la couche de base HDR10 prend le relais"
          : "refusé, et sans couche de base : passage au lecteur serveur";
    trace(`dolby vision : ${videoTrack.dolbyVision.type} présent — ${detail}`);
  }
  if (dv.kind === "server") return { reason: dv.reason, server: true };

  try {
    const remuxer = await Remuxer.open(source, file, videoTrack, audioTrack, dimensions, dv.kind === "dolby" ? dv.box : null);
    trace("chemin : remultiplexeur ouvert");
    return { remuxer, plan: remuxer.plan() };
  } catch (error) {
    return error instanceof Error ? error.message : "ouverture impossible";
  }
}

export async function choosePlaybackPath(input: PathInput): Promise<ChosenPath> {
  const attempts: PathAttempt[] = [];

  const remux = await tryRemux(input);
  if (typeof remux === "object" && "remuxer" in remux) {
    attempts.push({ path: "remux", ok: true });
    return { path: "remux", remuxer: remux.remuxer, plan: remux.plan, attempts };
  }
  const refus = typeof remux === "string" ? { reason: remux, server: false as const } : remux;
  trace(`chemin : remultiplexage refusé — ${refus.reason}`);
  attempts.push({ path: "remux", ok: false, reason: refus.reason });

  // Un refus qui vise ce lecteur et non ce chemin s'arrête ici : voir `NoLocalPath`. Essayer le
  // canevas par-dessus, c'est décoder un 4K pour aboutir au repli qu'on vient de choisir.
  if (refus.server) {
    attempts.push({ path: "webcodecs", ok: false, reason: refus.reason });
    throw new Error(`Aucun chemin de lecture disponible pour ce fichier. remux : ${refus.reason}`);
  }

  // Second choice, and it has to be able to say no as clearly as the first did.
  const webcodecsReason = unsupportedReason(input.videoTrack);
  if (webcodecsReason) {
    attempts.push({ path: "webcodecs", ok: false, reason: webcodecsReason });
    const explained = attempts.map((a) => `${a.path} : ${a.reason}`).join(" · ");
    throw new Error(`Aucun chemin de lecture disponible pour ce fichier. ${explained}`);
  }

  attempts.push({ path: "webcodecs", ok: true });
  return { path: "webcodecs", remuxer: null, plan: null, attempts };
}

/** A one-line summary of the decision, for the technical panel. */
export function describePath(chosen: ChosenPath): string {
  const rejected = chosen.attempts.filter((a) => !a.ok);
  const name = chosen.path === "remux" ? "remultiplexage → lecteur natif" : "WebCodecs → canvas";
  if (rejected.length === 0) return name;
  return `${name} (après : ${rejected.map((a) => `${a.path} refusé — ${a.reason}`).join(" ; ")})`;
}
