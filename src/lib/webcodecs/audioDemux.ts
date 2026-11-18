// Le son décodé, lu par NOTRE lecteur de conteneur — essai du 19/11/2026 (branche essai/demux-son).
//
// Jusqu'ici, une piste son que le navigateur ne décode pas (AC-3, E-AC3, DTS, FLAC, l'Opus et l'AAC
// qu'il refuse) passait par mediabunny de bout en bout : son propre lecteur Matroska/MP4 relisait
// l'en-tête et l'index que le nôtre venait de lire pour l'image, décidait seul où commencer après un
// saut, et enchaînait les paquets jusqu'au décodeur (`AudioSampleSink.samples`). Deux lecteurs du
// même fichier, deux idées de « l'instant 1 234 s » — et un comportement au saut qu'on ne voyait que
// de l'extérieur : en 1.62.0, un saut au-delà de la dernière trame d'une piste plus courte que le
// film relisait le fichier entier (18,9 Go pour un film, `mediabunny-tail-scan.test.ts`).
//
// Ici, les paquets viennent du lecteur qui sert déjà l'image (`createSampleReader`, Matroska ou MP4)
// et de son index ; on ne garde de mediabunny que ses **décodeurs** (AC-3/E-AC3, DTS) — et pour le
// FLAC le nôtre, pour l'Opus et l'AAC celui du navigateur. Le TrueHD fait déjà ainsi depuis le
// 21/09/2026 (truehd/truehdAudio.ts) : c'est le même modèle, étendu.
//
// Ce que ce module reproduit de mediabunny, exprès, pour que le son livré soit identique :
// - le point de départ : le dernier paquet dont l'instant est ≤ à celui demandé (le premier de la
//   piste si on demande avant lui), comme `getKeyPacket(t) ?? getFirstKeyPacket()` — tout paquet
//   audio de ces codecs est un point d'entrée ;
// - l'étalement des trames d'un bloc « laçé » sur la durée du bloc (`expandLacedBlocks`) ;
// - l'horloge du décodé : cumulée sur les durées rendues, recalée seulement quand l'écart avec
//   l'instant du décodeur atteint une trame, arrondie à l'échantillon (`AudioDecoderWrapper`) ;
// - le tri des trames : la dernière qui commence avant l'instant demandé, puis toutes les
//   suivantes (`mediaSamplesInRange`).
//
// Ce qu'il fait autrement, exprès : il **abandonne** une piste qui ne rend plus rien. Passé
// `GIVE_UP_S` secondes de fichier sans un paquet de la piste (depuis son dernier paquet, ou depuis
// le début de la lecture s'il n'en a vu aucun) — un doublage
// qui s'arrête avant le générique —, la lecture s'arrête là au lieu de descendre jusqu'à la fin du
// fichier. Le transcodeur comble de silence ce qui manque, comme pour un son qui commence tard.
import type { ByteSource } from "./byteSource";
import { clusterOffsetForTime, type MatroskaFile, type MatroskaTrack } from "./matroska";
import { createSampleReader } from "./mediaFile";

/** Un paquet audio de la piste, aux instants que mediabunny lui donnerait (en secondes). */
export interface DemuxedAudioPacket {
  data: Uint8Array;
  timestamp: number;
  duration: number;
}

/**
 * Combien remonter avant l'instant voulu pour être sûr d'avoir le paquet qui le contient. L'index
 * (Cues) pointe sur les images clés de la vidéo, avant l'instant ; une seconde de plus couvre un
 * index qui tomberait pile dessus, et le paquet qui le précède avec.
 */
const MARGIN_US = 1_000_000;

/**
 * Au-delà, une piste qui ne rend plus rien est finie pour cette lecture. Mesuré sur la bibliothèque :
 * aucun trou intérieur à une piste ne dépasse quelques secondes (le plus long est le silence de tête
 * de *The Circle*, 30 s — mais celui-là est *avant* le premier paquet, et un départ avant le premier
 * paquet prend le premier, sans rien chercher).
 */
export const GIVE_UP_S = 45;

/** Ce que ce lecteur a coûté, pour le banc et, plus tard, pour la ligne `stop`. */
export interface AudioDemuxStats {
  /** Blocs lus (toutes pistes) pour trouver le premier paquet. */
  scanned: number;
  /** Abandons sur une piste finie (`GIVE_UP_S`). */
  gaveUp: number;
}

export function newAudioDemuxStats(): AudioDemuxStats {
  return { scanned: 0, gaveUp: 0 };
}

/**
 * Les paquets d'une piste à partir de `fromSeconds` : le dernier dont l'instant est ≤, puis tous les
 * suivants jusqu'à la fin de la piste.
 */
export async function* audioPacketsFrom(
  source: ByteSource,
  file: MatroskaFile,
  trackNumber: number,
  fromSeconds: number,
  stats: AudioDemuxStats = newAudioDemuxStats()
): AsyncGenerator<DemuxedAudioPacket> {
  const track = file.tracks.find((t) => t.number === trackNumber);
  if (!track) throw new Error(`piste ${trackNumber} introuvable`);
  const fromUs = Math.max(0, fromSeconds) * 1e6;
  const start =
    clusterOffsetForTime(file, Math.max(0, fromUs - MARGIN_US)) ?? file.firstClusterOffset ?? file.segmentDataStart;
  const reader = createSampleReader(source, file, start);
  const laced = lacedTimeline(track);

  let pending: DemuxedAudioPacket | null = null;
  let started = false;
  // Depuis quand la piste se tait : son dernier paquet, ou à défaut le début de cette lecture.
  let silentSinceUs: number | null = null;
  for (;;) {
    const sample = await reader.next();
    if (!sample) break;
    if (!started) stats.scanned += 1;
    silentSinceUs ??= sample.timestampUs;
    if (sample.trackNumber !== trackNumber) {
      // Une piste finie : plus rien d'elle depuis longtemps, alors que le fichier continue.
      if (sample.timestampUs - silentSinceUs > GIVE_UP_S * 1e6) {
        stats.gaveUp += 1;
        break;
      }
      continue;
    }
    silentSinceUs = sample.timestampUs;
    for (const packet of laced.push(sample.timestampUs, sample.durationUs, sample.data)) {
      if (!started) {
        if (packet.timestamp * 1e6 <= fromUs) {
          pending = packet;
          continue;
        }
        started = true;
        if (pending) yield pending;
        pending = null;
      }
      yield packet;
    }
  }
  for (const packet of laced.end()) {
    if (!started) {
      if (packet.timestamp * 1e6 <= fromUs) {
        pending = packet;
        continue;
      }
      started = true;
      if (pending) yield pending;
      pending = null;
    }
    yield packet;
  }
  // Rien après l'instant voulu : le dernier paquet avant lui, seul — comme mediabunny.
  if (!started && pending) yield pending;
}

/**
 * Remet les trames d'un bloc « laçé » à leur place dans le temps. Notre lecteur donne à chaque trame
 * l'instant du bloc ; mediabunny étale la durée du bloc sur ses trames (la durée : celle du bloc
 * s'il la dit, sinon l'écart jusqu'au bloc suivant de la piste, sinon `DefaultDuration` × trames).
 * Il faut donc voir le bloc suivant avant de rendre celui-ci : un bloc de retard.
 */
function lacedTimeline(track: MatroskaTrack) {
  const defaultUs = track.defaultDurationNs ? track.defaultDurationNs / 1000 : null;
  let group: { ts: number; durationUs: number | null; frames: Uint8Array[] } | null = null;

  const spread = (g: NonNullable<typeof group>, nextTs: number | null): DemuxedAudioPacket[] => {
    const n = g.frames.length;
    let total: number | null = g.durationUs;
    if (total === null && nextTs !== null) total = nextTs - g.ts;
    if (total === null && defaultUs !== null) total = defaultUs * n;
    const each = total !== null && total > 0 ? total / n : 0;
    return g.frames.map((data, i) => ({ data, timestamp: (g.ts + i * each) / 1e6, duration: each / 1e6 }));
  };

  return {
    push(ts: number, durationUs: number | null, data: Uint8Array): DemuxedAudioPacket[] {
      // Notre lecteur rend les trames d'un même bloc à la suite, au même instant.
      if (group && group.ts === ts) {
        group.frames.push(data);
        return [];
      }
      const out = group ? spread(group, ts) : [];
      group = { ts, durationUs, frames: [data] };
      return out;
    },
    end(): DemuxedAudioPacket[] {
      const out = group ? spread(group, null) : [];
      group = null;
      return out;
    },
  };
}

/** Une trame décodée, prête pour le transcodeur : plans Float32, instant en secondes. */
export interface DecodedFrame {
  planes: Float32Array[];
  sampleRate: number;
  timestampSeconds: number;
}

/** Le décodeur, quel qu'il soit : un paquet entre, zéro ou plusieurs trames sortent par `onFrame`. */
export interface PacketDecoder {
  decode(packet: DemuxedAudioPacket): Promise<void>;
  flush(): Promise<void>;
  close(): void;
}

export interface RawFrame {
  planes: Float32Array[];
  sampleRate: number;
  /** L'instant que le décodeur lui donne, en secondes. */
  timestamp: number;
}

/**
 * Le décodé à partir de `fromSeconds`, horloge et tri compris — ce que rendait
 * `AudioSampleSink.samples(fromSeconds)` (voir l'en-tête).
 */
export async function* decodedFrom(
  packets: AsyncIterable<DemuxedAudioPacket>,
  openDecoder: (onFrame: (frame: RawFrame) => void, onError: (error: unknown) => void) => Promise<PacketDecoder>,
  fromSeconds: number,
  configSampleRate: number
): AsyncGenerator<DecodedFrame> {
  const ready: DecodedFrame[] = [];
  let failure: { error: unknown } | null = null;
  // L'horloge du décodé (AudioDecoderWrapper) : cumulée, recalée sur le décodeur dès qu'on s'en
  // écarte d'une trame, arrondie à l'échantillon.
  let current: number | null = null;
  let last: DecodedFrame | null = null;
  let firstQueued = false;

  const onFrame = (frame: RawFrame) => {
    const frames = frame.planes[0]?.length ?? 0;
    const duration = frames / frame.sampleRate;
    if (current === null || Math.abs(frame.timestamp - current) >= duration) current = frame.timestamp;
    const precise: number = current;
    current += duration;
    if (frames === 0) return;
    const decoded: DecodedFrame = {
      planes: frame.planes,
      sampleRate: frame.sampleRate,
      timestampSeconds: Math.round(precise * configSampleRate) / configSampleRate,
    };
    // Le tri (mediaSamplesInRange) : la dernière trame qui commence à l'instant voulu ou avant, puis
    // tout ce qui suit.
    if (last && decoded.timestampSeconds > fromSeconds) {
      ready.push(last);
      firstQueued = true;
    }
    if (decoded.timestampSeconds >= fromSeconds) {
      ready.push(decoded);
      firstQueued = true;
    }
    last = firstQueued ? null : decoded;
  };

  const decoder = await openDecoder(onFrame, (error) => {
    failure ??= { error };
  });
  try {
    for await (const packet of packets) {
      await decoder.decode(packet);
      if (failure) throw (failure as { error: unknown }).error;
      while (ready.length > 0) yield ready.shift()!;
    }
    await decoder.flush();
    if (failure) throw (failure as { error: unknown }).error;
    if (!firstQueued && last) ready.push(last);
    while (ready.length > 0) yield ready.shift()!;
  } finally {
    decoder.close();
  }
}
