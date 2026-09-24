// Whether this file can be played here, and why not when it cannot.
//
// One local path: remux to fragmented MP4 and hand it to a real <video>. The browser decodes in
// hardware, composites the picture itself, drives its own audio clock and displays HDR natively;
// no pixel passes through JavaScript, and the only audio that does is a track this browser cannot
// take as it is, re-encoded on the way (audioTranscode.ts). When it cannot carry a file, the
// refusal says exactly why, and the player hands the file to the server player — which transcodes
// what nothing here can.
//
// There used to be a second local path, a WebCodecs engine painting a canvas, tried before the
// server. It was removed on 2026-09-24: ten sessions in three weeks, all of them tests, all ending
// in the same server fallback a second later, and every reason that once led there now handled by
// the native path. It also forced a distinction every refusal had to make — "not by this path" or
// "not by this player" — which is gone with it. See docs/lecteur-canvas.md.

import { isNetworkFailure, isReadAbandoned, type ByteSource } from "./byteSource";
import { dolbyVisionInfo } from "./codecConfig";
import type { MatroskaFile, MatroskaTrack } from "./matroska";
import { playabilityOf } from "./mseSource";
import { trace } from "./trace";
import { audioDecoderExists, chooseTranscodePlan, chooseTranscodeCodec } from "./audioTranscode";
import {
  Remuxer,
  audioDelivery,
  plannedMimeTypes,
  playableAudio,
  remuxableVideo,
  type RemuxOptions,
  type RemuxPlan,
} from "./remuxer";

/** Placeholder for the playability probe, which only ever reads the MIME strings. */
const EMPTY = new Uint8Array(0);

/** The remux path, opened and ready to start. */
export interface ChosenPath {
  path: "remux";
  remuxer: Remuxer;
  plan: RemuxPlan;
}

export interface PathInput {
  source: ByteSource;
  file: MatroskaFile;
  videoTrack: MatroskaTrack;
  audioTrack: MatroskaTrack | null;
  dimensions: { width: number; height: number };
  /** Ce que le serveur sait de la plage dynamique — voir `RemuxPlaybackOptions.videoRangeType`. */
  videoRangeType?: string | null;
  /** Où la lecture commencera — pour y amorcer un encodeur audio, voir `Remuxer.open`. */
  startSeconds?: number;
  /**
   * Les réglages de ce remultiplexage — plafond de lumière HDR, livraison audio —, donnés à
   * l'ouverture et non plus posés sur le module : voir `RemuxOptions`. Le plan (types MIME,
   * ré-encodage ou non) et le remultiplexeur ouvert lisent les mêmes.
   */
  remux?: RemuxOptions;
}

/**
 * **L'interrupteur du Dolby Vision.**
 *
 * La sonde tourne, sa réponse est écrite dans le journal, et ce drapeau décide si on la croit.
 * (Il avait un pendant pour le remplacement du tampon audio en cours de lecture, jamais cru —
 * Safari l'acceptait puis jouait muet —, retiré le 22/09/2026 avec ce changement de piste.)
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

/** The remux path opened for this file, or why it cannot carry it. */
async function tryRemux(input: PathInput): Promise<{ remuxer: Remuxer; plan: RemuxPlan } | string> {
  const { file, videoTrack, audioTrack, dimensions, source } = input;

  trace(`chemin : examen du remultiplexage — vidéo ${videoTrack.codecId}, audio ${audioTrack?.codecId ?? "aucune"}`);

  // Asked first, because everything below names the codec a re-encoded track will be delivered
  // as, and only the browser knows what it can both produce and take back.
  if (audioTrack) {
    await chooseTranscodeCodec(audioTrack.audio?.sampleRate ?? 48000, audioTrack.audio?.channels ?? 2);
  }

  if (!remuxableVideo(videoTrack)) return `vidéo ${videoTrack.codecId} non remultiplexable`;
  if (audioTrack && !playableAudio(audioTrack)) {
    // Deux refus distincts, pour que le journal dise lequel : une piste que rien ne sait lire (le
    // MP2, balayage du 24/09/2026), et une piste lisible qui ne traverse pas MediaSource ici. Le
    // lecteur serveur est la suite des deux.
    if (!audioDecoderExists(audioTrack)) return `audio ${audioTrack.codecId} : aucun décodeur, ni ici ni dans le navigateur`;
    return `audio ${audioTrack.codecId} non remultiplexable`;
  }

  // Asked before a megabyte and a half of decoder is fetched. A track that has to be re-encoded
  // is only carried here if this browser will do the encoding, and finding that out afterwards
  // would mean paying for the download to learn it.
  if (audioTrack && audioDelivery(audioTrack, file, input.remux) === "transcode") {
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
      // Deux canaux d'ambiance en moins valent mieux qu'un film confié au lecteur serveur.
      trace(`chemin : ${channels} canaux non encodables ici, la piste sera livrée en ${plan.channels}`);
    }
  }

  // Asked before anything is opened. Describing an AC-3 track means reading a frame out of the
  // file, and there is no reason to pay for that only to be told the browser wanted none of it.
  const mime = plannedMimeTypes(videoTrack, audioTrack, file, input.remux);
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
  if (dv.kind === "server") return dv.reason;

  try {
    const remuxer = await Remuxer.open(
      source,
      file,
      videoTrack,
      audioTrack,
      dimensions,
      dv.kind === "dolby" ? dv.box : null,
      input.startSeconds ?? 0,
      input.remux
    );
    trace("chemin : remultiplexeur ouvert");
    return { remuxer, plan: remuxer.plan() };
  } catch (error) {
    // Le réseau et la lecture abandonnée ne disent rien de ce chemin : ils remontent tels quels.
    // Changés en refus (chasse aux défauts du 22/09/2026), une coupure du Wi-Fi pendant
    // l'ouverture envoyait le film au lecteur serveur, qui a besoin du même réseau, et une
    // reconstruction pour un changement de piste répondait « piste refusée ». Remontée,
    // la panne réseau trouve l'écran « connexion perdue » de l'hôte (`isNetworkFailure`).
    if (isNetworkFailure(error) || isReadAbandoned(error)) throw error;
    return error instanceof Error ? error.message : "ouverture impossible";
  }
}

/**
 * Le chemin natif ouvert pour ce fichier, ou une erreur qui dit pourquoi il ne peut pas le porter.
 *
 * L'erreur est ce qui envoie le film au lecteur serveur (`fallToStable`, dans l'hôte). Son libellé
 * est gardé tel qu'il était pour un refus sans autre issue locale — « Aucun chemin de lecture
 * disponible pour ce fichier. remux : … » —, pour que le journal se lise de la même façon avant et
 * après le retrait du canevas.
 */
export async function choosePlaybackPath(input: PathInput): Promise<ChosenPath> {
  const remux = await tryRemux(input);
  if (typeof remux !== "string") return { path: "remux", remuxer: remux.remuxer, plan: remux.plan };
  trace(`chemin : remultiplexage refusé — ${remux}`);
  throw new Error(`Aucun chemin de lecture disponible pour ce fichier. remux : ${remux}`);
}

/** Le chemin, en mots, pour le panneau technique et le journal (`start.reason`). */
export const NATIVE_PATH = "remultiplexage → lecteur natif";
