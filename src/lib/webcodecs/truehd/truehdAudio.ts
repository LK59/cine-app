// Une piste TrueHD/MLP, décodée ici — la même forme que ce que rend le décodeur logiciel
// (SoftwareAudioTrack), pour que la suite de la chaîne ne sache pas d'où vient le son.
//
// Jusqu'au 21/09/2026, rien ne décodait le TrueHD dans un navigateur : ni le navigateur, ni
// mediabunny, qui ne publie de décodeurs que pour le Dolby Digital et le DTS. Un film dont la VO
// n'existait qu'en TrueHD — 35 sur cette bibliothèque, dont Top Gun Maverick, les Hobbit, les
// Pirates des Caraïbes — passait au lecteur serveur. Le décodeur de FFmpeg, compilé en WebAssembly
// (tools/truehd-wasm), le rend maintenant, et la suite est le chemin du DTS : ré-encodé en AAC.
//
// mediabunny n'est pas en jeu ici : son lecteur Matroska ne connaît pas A_TRUEHD. Les blocs sont
// lus par le nôtre, au travers du même cache d'octets que le reste du lecteur.
import type { ByteSource } from "../byteSource";
import { parseMatroska, clusterOffsetForTime, type MatroskaTrack } from "../matroska";
import { SampleReader } from "../sampleReader";
import type { DecodedAudio } from "../softwareAudio";
import { openTrueHdDecoder, type DecodedBatch } from "./truehdDecoder";

export const TRUEHD_CODECS = new Set(["A_TRUEHD", "A_MLP"]);

/**
 * Combien de son par lot. Un bloc TrueHD dure 1/1200 s ; par quart de seconde, un lot se décode
 * en quelques millisecondes et le navigateur reprend la main entre deux — voir truehdDecoder.ts.
 */
const BATCH_US = 250_000;

/**
 * Où commencer à lire avant l'instant demandé. Le décodeur ne rend rien avant une synchronisation
 * majeure — au plus 88 ms mesurées sur la bibliothèque, 1/8 s par la norme — et un amorçage plus
 * court laisserait un trou au début du segment.
 */
const PREROLL_US = 1_000_000;

/** Deux blocs se suivent si le second commence là où le premier finit, à 2 ms près. */
const CONTIGUOUS_S = 0.002;

/**
 * Un lot décodé, découpé en morceaux continus et ramené à ce qui commence à `fromSeconds`.
 *
 * Continus, parce qu'un bloc refusé au milieu — ou les premiers blocs après un saut, qui ne rendent
 * rien — laisse un trou, et que chaque morceau porte son propre instant : un seul morceau aurait
 * collé le son d'après le trou juste derrière celui d'avant. Et à partir du bloc qui contient
 * l'instant demandé, comme mediabunny le fait pour les autres codecs : le son d'avant, remis à
 * l'encodeur, aurait débordé sur le segment précédent.
 */
export function contiguousAudio(
  timestampsUs: number[],
  batch: DecodedBatch,
  fromSeconds: number,
  channels: number
): DecodedAudio[] {
  const out: DecodedAudio[] = [];
  const rate = batch.sampleRate;
  const source = batch.channels;
  let offset = 0; // en images, dans batch.pcm
  let group: { start: number; frames: number; first: number; next: number } | null = null;

  const close = () => {
    if (!group) return;
    const planes = Array.from({ length: channels }, () => new Float32Array(group!.frames));
    // Une piste qui rendrait moins de canaux que son en-tête n'en annonce : les manquants restent
    // silencieux, plutôt que de décaler les autres. Plus : les derniers sont ignorés. Aucune piste
    // de la bibliothèque n'est dans ce cas ; c'est la forme que l'encodeur attend qui compte.
    const kept = Math.min(channels, source);
    for (let i = 0; i < group.frames; i++) {
      const base = (group.start + i) * source;
      for (let c = 0; c < kept; c++) planes[c][i] = batch.pcm[base + c];
    }
    out.push({ planes, sampleRate: rate, timestampSeconds: group.first });
    group = null;
  };

  for (let i = 0; i < timestampsUs.length; i++) {
    const frames = batch.frames[i];
    if (frames <= 0) {
      close();
      continue;
    }
    const start = timestampsUs[i] / 1e6;
    const end = start + frames / rate;
    if (end <= fromSeconds) {
      offset += frames;
      continue;
    }
    if (group && Math.abs(start - group.next) > CONTIGUOUS_S) close();
    if (!group) group = { start: offset, frames: 0, first: start, next: start };
    group.frames += frames;
    group.next = end;
    offset += frames;
  }
  close();
  return out;
}

export interface TrueHdTrack {
  format: { sampleRate: number; numberOfChannels: number };
  samples(fromSeconds: number): AsyncGenerator<DecodedAudio>;
  close(): void;
}

export async function openTrueHdTrack(source: ByteSource, trackNumber: number): Promise<TrueHdTrack> {
  const file = await parseMatroska(source);
  const found: MatroskaTrack | undefined = file.tracks.find((t) => t.number === trackNumber && t.type === "audio");
  if (!found || !TRUEHD_CODECS.has(found.codecId)) throw new Error("piste TrueHD introuvable");
  const track: MatroskaTrack = found;
  const decoder = await openTrueHdDecoder(track.codecId === "A_MLP");
  // L'en-tête Matroska, et non un premier décodage : lire le début du film pour l'apprendre
  // coûterait des mégaoctets de 4K à qui reprend à une heure. Sur la bibliothèque, il dit juste
  // pour les 52 pistes (8 canaux Atmos, 6 pour les 5.1, 48 kHz).
  const format = {
    sampleRate: track.audio?.sampleRate ?? 48000,
    numberOfChannels: track.audio?.channels ?? 8,
  };
  let generation = 0;
  let closed = false;

  /**
   * Un seul flux vivant à la fois. Le transcodeur abandonne un flux pour en ouvrir un autre à
   * chaque saut ; l'ancien, suspendu sur un décodage en cours, ne doit plus rien envoyer au
   * décodeur partagé — ses blocs seraient décodés au milieu de ceux du nouvel endroit.
   */
  async function* samples(fromSeconds: number): AsyncGenerator<DecodedAudio> {
    const mine = ++generation;
    decoder.reset();
    const fromUs = Math.max(0, fromSeconds) * 1e6;
    const start = clusterOffsetForTime(file, Math.max(0, fromUs - PREROLL_US)) ?? file.firstClusterOffset ?? file.segmentDataStart;
    const reader = new SampleReader(source, file, start);
    let blocks: Uint8Array[] = [];
    let times: number[] = [];

    const decodeBatch = async (): Promise<DecodedAudio[]> => {
      const batch = await decoder.decode(blocks);
      const pieces = contiguousAudio(times, batch, fromSeconds, format.numberOfChannels);
      blocks = [];
      times = [];
      return pieces;
    };

    for (;;) {
      if (closed || mine !== generation) return;
      const sample = await reader.next();
      if (!sample) break;
      if (sample.trackNumber !== track.number) continue;
      // Les blocs d'avant l'amorçage utile ne sont pas jetés : le décodeur a besoin d'eux pour
      // trouver sa synchronisation. C'est contiguousAudio qui ne garde que ce qui compte.
      blocks.push(sample.data);
      times.push(sample.timestampUs);
      if (times[times.length - 1] - times[0] < BATCH_US) continue;
      const pieces = await decodeBatch();
      if (closed || mine !== generation) return;
      for (const piece of pieces) yield piece;
    }
    if (blocks.length > 0 && !closed && mine === generation) {
      for (const piece of await decodeBatch()) yield piece;
    }
  }

  return {
    format,
    samples,
    close() {
      closed = true;
      decoder.close();
    },
  };
}
