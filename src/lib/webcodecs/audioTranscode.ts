// Sound for codecs no browser will accept, turned into sound every browser accepts.
//
// DTS is the case this exists for. No browser decodes it, and — separately — no browser will take
// it inside a MediaSource even if one did, so a DTS track can never be handed to the player as it
// is. Every option that keeps the picture on the hardware path therefore ends in the same place:
// decode the sound here, encode it again as something the player does accept, and put that in the
// container instead. The video is not touched, which is the whole point.
//
// The half-second of latency this adds is spent ahead of playback, not at it: a segment's audio is
// produced while the previous one is still being watched.

import { audioSampleEntryFor } from "./mp4SampleEntries";
import { SoftwareAudioTrack, type DecodedAudio } from "./softwareAudio";
import type { ByteSource } from "./byteSource";
import type { MatroskaFile, MatroskaTrack } from "./matroska";
import { trace } from "./trace";
import { containerAccepts } from "./mseSource";
import { extractAudioSpecificConfig, opusSampleEntry, parseAacConfig } from "./mp4SampleEntries";

/** AAC-LC. The one encoder both an iPhone and a desktop browser were measured to offer. */
const TARGET_CODEC = "mp4a.40.2";

/**
 * The fallback for a browser with no AAC encoder.
 *
 * Firefox is one: it plays AAC perfectly well and cannot produce it, while it both encodes Opus
 * — in stereo and in 5.1 — and accepts it in a MediaSource. Measured, not assumed; the panel's
 * probe says so on the machine in front of the viewer. Without this, every file whose sound has
 * to be re-encoded loses the hardware path there, and on 10-bit HEVC the software path has no
 * decoder either, so it loses playback altogether.
 */
const FALLBACK_CODEC = "opus";

/**
 * How far past a segment's end the encoder is fed before its output is taken.
 *
 * An encoder holds a frame or two before it hands anything back. Feeding a little beyond the
 * boundary is what lets it emit everything belonging below it — without being flushed, which for
 * a frame-based codec means padding or discarding whatever did not fill the current frame.
 */
const ENCODER_LOOKAHEAD_SECONDS = 0.3;

/** How long the encoder is given to describe itself before this is called a refusal. */
const PRIMING_TIMEOUT_MS = 8000;

/**
 * The bitrates asked for, best first — per channel, because that is what hearing depends on.
 *
 * Generous on purpose, for two reasons. Left to choose, Safari answers a low default with SBR — a
 * different object type, twice the sample rate, and a description that contradicts the
 * `mp4a.40.2` written beside it; asking for enough bits is the polite way to get the plain
 * profile, and reading back what actually came out, below, is the way that does not depend on
 * being obeyed. And quality: until 22/09/2026 this was a single 320 kbit/s for any layout — 40
 * per channel on a 7.1, a second lossy generation of a 640 kbit/s E-AC3, or of a lossless TrueHD,
 * that a good pair of headphones could tell apart. AAC-LC stops being distinguishable from its
 * source at 80 to 96 per channel. The bits cost nothing on the network — the encoder runs here,
 * and its output only ever reaches this browser's own buffer.
 *
 * A ladder rather than one figure: an encoder may decline a rate and accept a lower one, and the
 * first it accepts is the one kept. Stereo never goes below 128.
 */
const KBITS_PER_CHANNEL = [96, 64, 40];

/**
 * Le plafond appris pendant la session, par nombre de canaux : un débit sous lequel l'encodeur a
 * tenu, faute d'avoir tenu au-dessus.
 *
 * Mesuré sur iPhone le 21/09/2026 : l'encodeur AAC d'Apple, « InternalAudioEncoderCocoa »,
 * accepte 768 kbit/s en 7.1, s'amorce, puis échoue parfois en cours de route — et les
 * reconstructions qui suivaient demandaient à nouveau 768, échouaient pareil, jusqu'à céder le
 * film au lecteur serveur. Un échec *en cours de route* fait donc descendre d'un barreau, pour le
 * reste de la page : le transcodeur suivant commence directement au débit qui a une chance de
 * tenir. Rien n'est écrit nulle part — un autre appareil, ou demain, recommence en haut.
 */
const ceilings = new Map<number, number>();

function bitrateLadder(channels: number): number[] {
  const ceiling = ceilings.get(channels) ?? Infinity;
  const all = [...new Set(KBITS_PER_CHANNEL.map((k) => Math.max(128_000, k * 1000 * channels)))];
  const below = all.filter((rate) => rate < ceiling);
  // Jamais vide : le dernier barreau reste, quoi qu'il arrive. Sans débit imposé, Safari répond
  // en HE-AAC (SBR), un autre type d'objet que celui déjà décrit au tampon — et c'est précisément
  // le changement qu'un tampon vivant ne survit pas.
  return below.length > 0 ? below : all.slice(-1);
}

/** Pour les tests : l'état d'une page neuve. */
export function forgetBitrateCeilings(): void {
  ceilings.clear();
}

/**
 * Codecs there is a decoder for here, whether or not the browser has one.
 *
 * Being on this list does not mean a track will be re-encoded — only that it *can* be, if the
 * browser turns out not to accept it. Which of the two happens is a question for the browser, not
 * a property of the codec: an iPhone takes AC-3 in a container untouched and should never pay for
 * a decode, while Chrome ships no Dolby decoder at all and would otherwise be shut out of the
 * hardware path for most of a library.
 */
const DECODABLE_HERE = new Set([
  "A_DTS",
  "A_DTS/EXPRESS",
  "A_DTS/LOSSLESS",
  "A_AC3",
  "A_EAC3",
  // Carried untouched wherever the browser takes it (Chrome, Firefox); decoded here, by
  // libFLAC, only where it does not — Safari. See flacDecoder.ts.
  "A_FLAC",
  // No browser takes these anywhere. FFmpeg's own decoder, compiled to WebAssembly since
  // 21/09/2026 — see truehd/truehdAudio.ts.
  "A_TRUEHD",
  "A_MLP",
  // A_OPUS aussi, en mono et en stéréo seulement — voir transcodableAudio. Safari décode l'Opus
  // mais ne le prend pas dans MediaSource : 608 pistes de séries ici. Décodé par le navigateur
  // lui-même (mediabunny passe par son AudioDecoder), ré-encodé en AAC. Au-delà de deux canaux,
  // l'ordre dans lequel le décodeur d'Apple rend un Opus multicanal n'a jamais été mesuré : ces
  // pistes (76, en 3.0) gardent leur chemin d'avant plutôt qu'un pari sur la place des voix.
]);

export function transcodableAudio(track: MatroskaTrack): boolean {
  if (track.codecId === "A_OPUS") return (track.audio?.channels ?? 2) <= 2;
  return DECODABLE_HERE.has(track.codecId);
}

export interface TranscodedFrame {
  data: Uint8Array;
  timestampUs: number;
  durationUs: number;
}

/**
 * Whether this browser can encode what we would hand it.
 *
 * Asked with and without a bitrate: a browser can decline one rate while accepting the codec, and
 * reading that as a refusal would send a file down a slower path for no reason. Measured on a
 * desktop Chrome, which says no at 256 kbit/s and yes with nothing specified.
 */
/** Every shape worth asking about for one codec, best first. */
function candidateConfigs(codec: string, sampleRate: number, numberOfChannels: number): AudioEncoderConfig[] {
  const rates = bitrateLadder(numberOfChannels);
  return codec === TARGET_CODEC
    ? [
        ...rates.map((bitrate) => ({ codec, sampleRate, numberOfChannels, bitrate, aac: { format: "aac" as const } })),
        { codec, sampleRate, numberOfChannels, aac: { format: "aac" } },
        { codec, sampleRate, numberOfChannels },
      ]
    : [
        ...rates.map((bitrate) => ({ codec, sampleRate, numberOfChannels, bitrate })),
        { codec, sampleRate, numberOfChannels },
      ];
}

async function firstSupported(codec: string, sampleRate: number, channels: number): Promise<AudioEncoderConfig | null> {
  const Encoder = (globalThis as { AudioEncoder?: typeof AudioEncoder }).AudioEncoder;
  if (!Encoder?.isConfigSupported) return null;
  for (const config of candidateConfigs(codec, sampleRate, channels)) {
    try {
      if ((await Encoder.isConfigSupported(config)).supported) return config;
    } catch {
      // A configuration the browser considers malformed rather than unsupported.
    }
  }
  return null;
}

/** Toutes les formes que le navigateur dit accepter, dans l'ordre de l'échelle ; au pire, la plus nue. */
async function supportedConfigs(codec: string, sampleRate: number, channels: number): Promise<AudioEncoderConfig[]> {
  const Encoder = (globalThis as { AudioEncoder?: typeof AudioEncoder }).AudioEncoder;
  const accepted: AudioEncoderConfig[] = [];
  for (const config of candidateConfigs(codec, sampleRate, channels)) {
    try {
      if ((await Encoder?.isConfigSupported(config))?.supported) accepted.push(config);
    } catch {
      // A configuration the browser considers malformed rather than unsupported.
    }
  }
  return accepted.length > 0 ? accepted : [{ codec, sampleRate, numberOfChannels: channels }];
}

function describeRate(config: AudioEncoderConfig): string {
  return config.bitrate ? `${Math.round(config.bitrate / 1000)} kbit/s` : "débit laissé au navigateur";
}

/**
 * La sortie des encodeurs, et celui qui a le droit d'y écrire.
 *
 * Un saut remplace l'encodeur par un neuf (voir `seekTo`). Le remplacé est fermé, mais une image
 * ou une erreur déjà en file chez lui peut encore arriver — et elle arrivait au transcodeur : une
 * image d'avant le saut mêlée aux nouvelles, ou un échec qui n'était plus le sien et qui faisait
 * reconstruire un encodeur sain et baisser le débit pour toute la page (relu le 22/09/2026). Seul
 * l'encodeur courant est écouté.
 */
interface EncoderSink {
  frame: (frame: TranscodedFrame) => void;
  failed: (message: string) => void;
  current: AudioEncoder | null;
}

interface Primed {
  encoder: AudioEncoder;
  description: Uint8Array;
  config: AudioEncoderConfig;
  /** Où vont les images de l'encodeur ; redirigé vers le transcodeur une fois qu'il existe. */
  sink: EncoderSink;
}

/**
 * Configure un encodeur et lui fait encoder assez de son pour qu'il se décrive — ou dit pourquoi
 * il ne l'a pas fait. L'encodeur d'une tentative ratée est fermé ici.
 */
async function primeEncoder(
  Encoder: typeof AudioEncoder,
  config: AudioEncoderConfig,
  decoder: SoftwareAudioTrack,
  fromSeconds: number,
  outChannels: number
): Promise<Primed | { error: string; timedOut: boolean }> {
  let description: Uint8Array | null = null;
  let encoderError: string | null = null;
  // The encoder has to exist before the object that owns it, and it keeps handing frames back
  // for the rest of the session — so where they go is a reference, redirected at the instance
  // as soon as there is one. Left pointing at a local array, everything after the priming would
  // be encoded and quietly dropped.
  const sink: EncoderSink = {
    frame: (_frame: TranscodedFrame) => {},
    failed: (message: string) => {
      encoderError = message;
    },
    current: null,
  };

  const encoder: AudioEncoder = new Encoder({
    output: (chunk, metadata) => {
      if (sink.current !== encoder) return;
      const carried = metadata?.decoderConfig?.description;
      if (carried && !description) description = new Uint8Array(toBytes(carried));
      sink.frame(toFrame(chunk));
    },
    error: (error) => {
      if (sink.current === encoder) sink.failed(error.message);
    },
  });
  sink.current = encoder;
  const close = () => {
    try {
      encoder.close();
    } catch {
      // Already closed by whatever went wrong.
    }
  };
  try {
    encoder.configure(config);
  } catch (error) {
    close();
    return { error: error instanceof Error ? error.message : String(error), timedOut: false };
  }
  trace(`transcodage audio : encodeur configuré (${config.codec}, ${describeRate(config)}), amorçage à ${fromSeconds.toFixed(1)} s`);

  // Enough to make the encoder describe itself, and no more: this runs before the first frame
  // of video is shown, so it is time the viewer is waiting through. Bounded, because an
  // encoder that accepts a configuration and then never answers is a real possibility — and a
  // player that waits for ever on it is worse than one that says what went wrong.
  // Primed where playback is, not at the start of the film: this also runs on a language
  // change, and reading the opening back two hours in is network traffic spent on nothing.
  const primer = decoder.samples(Math.max(0, fromSeconds));
  const prime = async () => {
    // Fed, then waited on — never flushed. A flush asks a frame-based encoder to produce a
    // frame from whatever it happens to hold, and doing that after a single 512-sample block,
    // over and over, is what a desktop Chrome answered with "Flushing error". Enough blocks to
    // fill several frames come first, and the description arrives with the first of them.
    while (!description && !encoderError) {
      for (let i = 0; i < 8; i++) {
        const next = await primer.next();
        if (next.done) return;
        encode(encoder, next.value, outChannels, config.codec);
      }
      for (let i = 0; i < 200 && encoder.encodeQueueSize > 0; i++) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      // One turn of the event loop for the outputs the encoder has finished to be delivered.
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  };

  // Raced, not merely bounded by a loop condition. The wait that has to be survived is one
  // *inside* a call — a decoder that never yields, an encoder that never answers a flush — and
  // a deadline checked between iterations never gets its turn to look.
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  try {
    await Promise.race([
      prime(),
      new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          timedOut = true;
          resolve();
        }, PRIMING_TIMEOUT_MS);
      }),
    ]);
  } catch (error) {
    // Le décodeur qui lâche pendant l'amorçage — un FLAC que libFLAC refuse, un bloc TrueHD
    // illisible. L'erreur remontait telle quelle, et l'encodeur de cette tentative, que rien
    // d'autre ne connaît, restait ouvert : le navigateur n'en accorde qu'un nombre fixe.
    close();
    throw error;
  } finally {
    clearTimeout(timer);
    void primer.return?.(undefined);
  }

  if (encoderError) {
    close();
    return { error: `Encodage audio refusé : ${encoderError}`, timedOut: false };
  }
  if (!description) {
    close();
    return {
      error: timedOut
        ? `L'encodeur audio n'a pas répondu en ${PRIMING_TIMEOUT_MS / 1000} s.`
        : "L'encodeur audio n'a pas décrit le flux qu'il produit.",
      timedOut,
    };
  }
  return { encoder, description, config, sink };
}

/**
 * What this browser can be handed instead of a codec it will not take — or null if nothing.
 *
 * Both halves have to hold: the browser has to be able to *produce* it and to *accept* it back
 * in a MediaSource. Firefox encodes Opus and takes it; Safari encodes Opus and does not.
 */
export async function chooseTranscodeCodec(sampleRate: number, channels: number): Promise<string | null> {
  return (await chooseTranscodePlan(sampleRate, channels))?.codec ?? null;
}

/** Ce qui sera livré à la place de la piste : un codec, et un nombre de canaux. */
export interface TranscodePlan {
  codec: string;
  /** Peut être inférieur à celui de la source — voir la descente ci-dessous. */
  channels: number;
}

/**
 * Le même nombre de canaux si le navigateur sait l'encoder, sinon le plus proche qu'il sait.
 *
 * Mesuré sur un Chrome Windows : il encode l'AAC en 2 et en 6 canaux, pas en 8. Une piste
 * E-AC3 7.1 — le cas de « Mourir peut attendre », dont la piste française est en 7.1 Atmos —
 * n'avait donc aucun remplaçant, le remultiplexage était refusé, et la lecture tombait sur le
 * chemin canevas : décodage logiciel d'un 4K HDR, et pour une source Dolby Vision une image que
 * ce navigateur ne sait pas convertir. Le même fichier se lit nativement sur iPhone, qui accepte
 * l'E-AC3 tel quel.
 *
 * Descendre d'un 7.1 à un 5.1 coûte deux canaux d'ambiance ; le chemin canevas coûtait l'image.
 */
export async function chooseTranscodePlan(sampleRate: number, channels: number): Promise<TranscodePlan | null> {
  // Le compte de la source d'abord, puis les deux dispositions qu'un navigateur sait produire.
  // Jamais un compte sans disposition : cinq ou sept canaux ne disent pas où va chaque rang, et un
  // encodeur qui les accepte les range à sa façon. Portés au compte connu au-dessus — 5 → 6,
  // 7 → 8 —, ils passent par la règle de `fold` : L R C gardés, le reste muet (DOC-TECH, « Channel
  // order »). C'est aussi ce qui évite qu'un 5.1 unifié à sept canaux voie son ambiance gauche
  // rangée au rang de l'arrière central.
  const first = knownLayoutAtLeast(channels);
  const wanted = [first, ...[6, 2].filter((n) => n < first)];
  for (const target of wanted) {
    for (const codec of [TARGET_CODEC, FALLBACK_CODEC]) {
      if (target > appleAacCap(codec)) continue;
      if (!containerAccepts(`audio/mp4; codecs="${codec}"`)) continue;
      if (await firstSupported(codec, sampleRate, target)) {
        chosenTarget = codec;
        return { codec, channels: target };
      }
    }
  }
  return null;
}

/**
 * The answer to the question above, kept for the places that cannot wait for it.
 *
 * Deciding what a re-encoded track will be delivered as means asking the browser, which is
 * asynchronous; naming that codec in a MIME type happens in the middle of building a plan, which
 * is not. The question is always put first — the path selector asks it before anything else is
 * opened — so by the time this is read it is the measured answer and not the default.
 */
export function transcodeTargetCodec(): string {
  return chosenTarget;
}

let chosenTarget = TARGET_CODEC;

export async function canEncodeAac(sampleRate: number, numberOfChannels: number): Promise<boolean> {
  return (await chooseTranscodeCodec(sampleRate, numberOfChannels)) !== null;
}

/**
 * Deux horloges du son ré-encodé, suivies sur l'appareil — pour le journal de fin de séance.
 *
 * Un spectateur sur Chrome Android (22/09/2026) voyait le son se décaler peu à peu de l'image,
 * et un saut de dix secondes le recaler. Rien de ce qui est livré ne compare le temps du son à
 * celui du fichier : le temps des images ré-encodées est celui que l'encodeur de la plateforme
 * leur donne, et un saut repart d'un encodeur neuf. Ce qu'on mesure ici, en microsecondes :
 *
 * - `source` : l'écart entre les instants que le fichier donne au son décodé et la quantité de
 *   son effectivement décodée depuis le début du flux. Il grandit si le fichier a des trous — et
 *   un encodeur qui compte ses échantillons sans voir ces trous prendrait alors de l'avance ;
 * - `encoder` : l'écart entre les instants que l'encodeur rend et la quantité de son qu'il a
 *   rendue. Nul si l'encodeur compte ; il suit `source` si l'encodeur recale sur ses entrées.
 *
 * Les deux repartent à chaque saut, comme l'encodeur ; on garde le plus grand de la séance.
 */
export interface AudioTimingStats {
  sourceUs: number;
  encoderUs: number;
}

export class AudioTranscoder {
  private generator: AsyncGenerator<DecodedAudio> | null = null;
  /** Voir `AudioTimingStats` : l'état du flux en cours, et le pire de la séance. */
  private timing = { firstInUs: null as number | null, inFrames: 0, firstOutUs: null as number | null, outFrames: 0 };
  private timingWorst: AudioTimingStats = { sourceUs: 0, encoderUs: 0 };
  private pending: TranscodedFrame[] = [];
  private lastDecodedSeconds = 0;
  private exhausted = false;
  private failure: string | null = null;

  private constructor(
    private readonly decoder: SoftwareAudioTrack,
    private encoder: AudioEncoder,
    readonly sampleEntry: Uint8Array,
    readonly sampleRate: number,
    readonly channels: number,
    private readonly actualCodec: string = "mp4a.40.2",
    /**
     * La configuration exacte qui a produit la description écrite dans le conteneur — débit
     * compris —, remise telle quelle à chaque saut.
     *
     * Jusqu'au 22/09/2026, un saut reconfigurait l'encodeur avec le codec, la fréquence et les
     * canaux seulement : sans débit. Et l'ouverture se termine par un saut. Le débit demandé ne
     * servait donc qu'à l'amorçage, toute la lecture tournait au débit par défaut du navigateur,
     * et les images n'étaient plus produites par la configuration que leur en-tête décrivait.
     */
    private readonly config: AudioEncoderConfig = { codec: actualCodec, sampleRate, numberOfChannels: channels },
    /**
     * Un encodeur neuf, configuré comme celui-ci et branché au même endroit — voir seekTo. Absent
     * dans les tests qui construisent un transcodeur à la main : on retombe alors sur reset().
     */
    private readonly renew: (() => AudioEncoder) | null = null
  ) {}

  /** What the encoder actually produced, not what it was asked for. */
  get codecString(): string {
    return this.actualCodec;
  }

  /**
   * Toute la piste a été décodée, encodée et rendue : il n'y a plus rien à demander.
   *
   * C'est ce qui permet au remultiplexeur de dire que le fichier est fini — voir
   * `Remuxer.readUntilSettled`, qui ne le disait jamais tant qu'un transcodeur existait.
   */
  get drained(): boolean {
    return this.exhausted && this.pending.length === 0;
  }

  /**
   * Opens the track and gets far enough to describe it.
   *
   * The description an MP4 needs is not in the file — it is produced by the encoder, and only
   * once it has encoded something. So a little sound is pushed through here and kept, which is
   * also the earliest point at which a browser that cannot do this at all will say so.
   */
  static async open(
    source: ByteSource,
    track: MatroskaTrack,
    fromSeconds = 0,
    /**
     * La disposition imposée de l'extérieur, quand toutes les pistes du fichier doivent sortir
     * avec la même — voir `unifiedAudioChannels`. Sans elle, chaque piste choisit la sienne, et
     * le nombre de canaux change au milieu d'un tampon audio qui, sur certains navigateurs, n'en
     * accepte qu'un.
     */
    unifiedChannels?: number,
    /**
     * Le fichier déjà lu par l'appelant. Sans lui, le décodeur TrueHD relisait l'en-tête et
     * l'index d'un 4K de soixante gigaoctets à chaque changement de piste : 4,4 et 5,3 s mesurées
     * sur un iPhone le 21/09/2026, l'essentiel de l'attente.
     */
    file?: MatroskaFile
  ): Promise<AudioTranscoder> {
    const Encoder = (globalThis as { AudioEncoder?: typeof AudioEncoder }).AudioEncoder;
    if (!Encoder) throw new Error("Ce navigateur ne sait pas encoder de l'audio.");

    trace(`transcodage audio : chargement du décodeur ${track.codecId}`);
    const decoder = await SoftwareAudioTrack.open(source, track.number, track.codecId, file);
    // Tout ce qui suit peut lever — l'amorçage qui échoue sur le décodeur, une description que
    // l'on ne sait pas relire —, et le décodeur (pour le TrueHD, un contexte WebAssembly) comme
    // l'encodeur amorcé n'ont encore aucun propriétaire : fermés ici, sur chaque sortie en erreur.
    let primedEncoder: AudioEncoder | null = null;
    try {
      return await AudioTranscoder.build(Encoder, decoder, fromSeconds, unifiedChannels, (encoder) => {
        primedEncoder = encoder;
      });
    } catch (error) {
      try {
        (primedEncoder as AudioEncoder | null)?.close();
      } catch {
        // Déjà fermé par ce qui a échoué.
      }
      try {
        decoder.close();
      } catch {
        // Likewise.
      }
      throw error;
    }
  }

  /** La suite de `open`, une fois le décodeur ouvert — séparée pour que `open` ferme tout en cas d'échec. */
  private static async build(
    Encoder: typeof AudioEncoder,
    decoder: SoftwareAudioTrack,
    fromSeconds: number,
    unifiedChannels: number | undefined,
    onPrimed: (encoder: AudioEncoder) => void
  ): Promise<AudioTranscoder> {
    const { sampleRate, numberOfChannels } = decoder.format;
    trace(`transcodage audio : décodeur prêt — ${sampleRate} Hz, ${numberOfChannels} canaux`);
    const wanted = unifiedChannels ?? numberOfChannels;
    if (wanted !== numberOfChannels) {
      trace(`transcodage audio : disposition unifiée du fichier — ${numberOfChannels} canaux portés à ${wanted}`);
    }
    const plan = await chooseTranscodePlan(sampleRate, wanted);
    // Le décodeur est fermé par `open`, qui attrape tout ce qui sort d'ici en erreur.
    if (!plan) throw new Error(`Ce navigateur ne sait produire aucun codec audio en ${wanted} canaux.`);
    const target = plan.codec;
    const outChannels = plan.channels;
    // Comparé à ce qui a été *demandé*, pas à ce que la source portait : depuis que la
    // disposition peut être imposée par le fichier, une piste 5.1 portée à 8 déclenchait un
    // « 6 canaux non encodables, descente à 8 » qui ne veut rien dire. Le seul rabaissement qui
    // mérite d'être signalé est celui que l'encodeur impose.
    if (outChannels < wanted) {
      trace(`transcodage audio : ${wanted} canaux non encodables ici, descente à ${outChannels}`);
    } else if (outChannels > wanted) {
      trace(`transcodage audio : ${wanted} canaux sans disposition connue, livrés en ${outChannels} (L R C gardés)`);
    }

    // Les débits de l'échelle que le navigateur dit accepter, du meilleur au plus sobre — puis
    // rien d'imposé. Chacun est essayé *pour de vrai* : `isConfigSupported` peut dire oui à un
    // débit que l'encodeur refuse ensuite, et ce refus ne doit pas coûter le son quand un débit
    // plus bas, ou celui du navigateur, aurait marché.
    const configs = await supportedConfigs(target, sampleRate, outChannels);
    let primed: Primed | null = null;
    let failure = "";
    for (const config of configs) {
      const attempt = await primeEncoder(Encoder, config, decoder, fromSeconds, outChannels);
      if ("encoder" in attempt) {
        primed = attempt;
        break;
      }
      failure = attempt.error;
      trace(`transcodage audio : ${describeRate(config)} refusé à l'usage (${attempt.error})`);
      // Un encodeur qui ne répond pas ne répondra pas mieux à un autre débit : huit secondes
      // d'attente par barreau, ce serait une minute de film figé.
      if (attempt.timedOut) break;
    }
    if (!primed) throw new Error(failure || "L'encodeur audio n'a pas décrit le flux qu'il produit.");
    const { encoder, description, sink, config } = primed;
    onPrimed(encoder);

    // Asking for a profile is not the same as being given it. The description is the only
    // statement of what came out, and everything written beside it in the container — the codec
    // string, the sample rate, the channel count — has to agree with it or the init segment
    // contradicts itself. Safari does not merely refuse such a segment: it closes the
    // MediaSource, and every buffer on it, including the video's, becomes invalid.
    // Chrome hands back the bare configuration; Safari hands back the whole descriptor tree with
    // the configuration inside it. Both have to end up as the same bytes here, or the `esds`
    // built below describes a description.
    const asc = target === TARGET_CODEC ? (extractAudioSpecificConfig(description) ?? description) : description;
    const actual = target === TARGET_CODEC ? parseAacConfig(asc) : null;
    const read =
      target === TARGET_CODEC
        ? actual
          ? `AOT ${actual.objectType}, ${actual.sampleRate} Hz, ${actual.channels} canaux`
          : "illisible"
        : // Opus says the same things in its own header: channels at byte 9, rate little-endian
          // at 12. Worth reading back for the same reason as the AAC one — the container is
          // about to state both, and it has to state what actually came out.
          `${asc[9]} canaux, ${new DataView(asc.buffer, asc.byteOffset, asc.byteLength).getUint32(12, true)} Hz`;
    trace(
      `transcodage audio : encodeur amorcé — description ${[...(description as Uint8Array)]
        .map((b) => b.toString(16).padStart(2, "0"))
        .join(" ")}${asc === description ? "" : ` (config extraite : ${[...asc].map((b) => b.toString(16).padStart(2, "0")).join(" ")})`} → ${read}`
    );

    const entryRate = actual?.sampleRate ?? sampleRate;
    // Ce que l'encodeur produit réellement, qui peut être moins que la source — voir la descente.
    // `||` et non `??` : une configuration 0 veut dire « décrite ailleurs », pas « zéro canal ».
    const entryChannels = actual?.channels || outChannels;
    const codecString = target === TARGET_CODEC ? (actual ? `mp4a.40.${actual.objectType}` : TARGET_CODEC) : target;

    const sampleEntry =
      target === TARGET_CODEC
        ? audioSampleEntryFor({
            codecId: "A_AAC",
            codecPrivate: asc,
            channels: entryChannels,
            sampleRate: entryRate,
            firstFrame: null,
          })
        : // Opus describes itself with the identification header, which is not shaped like the
          // box an MP4 wants — see dOps.
          opusSampleEntry(asc, entryChannels, entryRate);

    const renew = () => {
      const fresh: AudioEncoder = new Encoder({
        // Même sortie que le premier, et le même droit d'y écrire : être l'encodeur courant.
        output: (chunk) => {
          if (sink.current === fresh) sink.frame(toFrame(chunk));
        },
        error: (error) => {
          if (sink.current === fresh) sink.failed(error.message);
        },
      });
      try {
        fresh.configure(config);
      } catch (error) {
        // Refusé dès la configuration : fermé ici, sinon il ne le serait jamais.
        try {
          fresh.close();
        } catch {
          // Déjà fermé par ce qui a échoué.
        }
        throw error;
      }
      sink.current = fresh;
      return fresh;
    };
    const transcoder = new AudioTranscoder(
      decoder,
      encoder,
      sampleEntry,
      sampleRate,
      outChannels,
      codecString,
      config,
      renew
    );
    sink.frame = (frame) => transcoder.collect(frame);
    sink.failed = (message) => transcoder.fail(message);
    // The priming output is thrown away rather than kept: the first segment asked for may be
    // anywhere. Reading it again costs nothing — those bytes are cached now.
    transcoder.seekTo(fromSeconds);
    return transcoder;
  }

  /** Restarts decoding at this point on the file's clock. */
  seekTo(seconds: number): void {
    void this.generator?.return?.(undefined);

    // The encoder is emptied too, and it has to be. It holds whatever did not fill a frame —
    // roughly half of one, always — and a flush after the jump would either emit that with its
    // old timestamp or, worse, weld it to the first samples from the new position and hand back
    // one frame made of two places in the film.
    //
    // Et c'est un encodeur **neuf** qui repart, plus le même remis à zéro. Sur iPhone, l'encodeur
    // AAC d'Apple échouait « parfois, toujours après un changement de piste, jamais au départ » —
    // la note était dans ce dépôt depuis des semaines, et le journal du 21/09/2026 l'a précisée :
    // chaque encodeur neuf s'amorçait, chaque échec suivait un reset() puis un configure(). Un
    // encodeur neuf, c'est le chemin qui n'a jamais échoué.
    try {
      if (this.renew) {
        const previous = this.encoder;
        this.encoder = this.renew();
        try {
          previous.close();
        } catch {
          // Already closed by an error it reported earlier.
        }
      } else {
        this.encoder.reset();
        this.encoder.configure(this.config);
      }
    } catch (error) {
      // An encoder that cannot even be made again: framesUpTo reports it.
      this.failure ??= `Encodage audio interrompu : ${error instanceof Error ? error.message : String(error)}`;
    }

    this.generator = this.decoder.samples(Math.max(0, seconds));
    // Un flux neuf, un encodeur neuf : les deux horloges repartent d'ici.
    this.timing = { firstInUs: null, inFrames: 0, firstOutUs: null, outFrames: 0 };
    this.pending = [];
    this.lastDecodedSeconds = seconds;
    this.exhausted = false;
  }

  /**
   * Every frame up to a point on the file's clock, encoded and ready to mux.
   *
   * Flushed at each boundary so a segment holds exactly its own sound. An encoder left to its own
   * schedule would hand the tail of one segment to the next, and the two would then disagree
   * about where they start.
   */
  async framesUpTo(endSeconds: number): Promise<TranscodedFrame[]> {
    if (this.failure) throw new Error(this.failure);
    if (!this.generator) this.seekTo(0);

    // Fed past the boundary rather than flushed at it. A flush is the only way to make a
    // frame-based encoder hand back a part-filled frame, and it does that by padding it or
    // throwing it away — every couple of seconds, for the length of a film. Feeding a little
    // beyond instead lets every frame belonging below the boundary come out whole and on time,
    // and the encoder carries its remainder across, exactly as it is meant to.
    const feedUntil = endSeconds + ENCODER_LOOKAHEAD_SECONDS;
    while (!this.exhausted && this.lastDecodedSeconds < feedUntil) {
      const next = await this.generator!.next();
      if (next.done) {
        this.exhausted = true;
        break;
      }
      this.lastDecodedSeconds = next.value.timestampSeconds;
      this.noteInput(next.value);
      encode(this.encoder, next.value, this.channels, this.actualCodec);
    }

    // At the end of the file there is nothing left to feed, so the remainder has to be asked for.
    if (this.exhausted) await this.encoder.flush();
    else await this.drain();
    if (this.failure) throw new Error(this.failure);

    const cut = endSeconds * 1e6;
    const ready = this.pending.filter((frame) => frame.timestampUs < cut);
    this.pending = this.pending.filter((frame) => frame.timestampUs >= cut);
    return ready;
  }

  /** Waits for what has been handed to the encoder to come back out, without forcing a frame. */
  private async drain(): Promise<void> {
    for (let i = 0; i < 200 && this.encoder.encodeQueueSize > 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }

  /** Both called by the encoder's own callbacks, redirected here once this object exists. */
  private collect(frame: TranscodedFrame): void {
    this.noteOutput(frame);
    this.pending.push(frame);
  }

  /** Le son décodé qui entre : son instant selon le fichier, contre ce qui a été décodé avant. */
  private noteInput(decoded: DecodedAudio): void {
    const at = decoded.timestampSeconds * 1e6;
    const frames = decoded.planes[0]?.length ?? 0;
    const rate = decoded.sampleRate || this.sampleRate;
    const timing = this.timing;
    if (timing.firstInUs === null) timing.firstInUs = at;
    const drift = at - timing.firstInUs - (timing.inFrames * 1e6) / rate;
    if (Math.abs(drift) > Math.abs(this.timingWorst.sourceUs)) this.timingWorst.sourceUs = drift;
    timing.inFrames += frames;
  }

  /** Une image encodée qui sort : son instant selon l'encodeur, contre ce qu'il a rendu avant. */
  private noteOutput(frame: TranscodedFrame): void {
    const timing = this.timing;
    if (timing.firstOutUs === null) timing.firstOutUs = frame.timestampUs;
    const drift = frame.timestampUs - timing.firstOutUs - (timing.outFrames * 1e6) / this.sampleRate;
    if (Math.abs(drift) > Math.abs(this.timingWorst.encoderUs)) this.timingWorst.encoderUs = drift;
    // En échantillons entiers, depuis la durée arrondie à la microseconde : additionner les
    // durées elles-mêmes accumulerait l'arrondi (0,33 µs par image AAC) et inventerait une dérive.
    timing.outFrames += Math.round(((frame.durationUs || 0) * this.sampleRate) / 1e6);
  }

  /** Le pire écart de la séance, pour le journal — voir `AudioTimingStats`. */
  get timingStats(): AudioTimingStats {
    return { ...this.timingWorst };
  }

  private closed = false;

  private fail(message: string): void {
    this.failure = `Encodage audio interrompu : ${message}`;
    // Un échec en cours de route au débit demandé : le suivant partira d'un barreau plus bas.
    // Sans débit imposé, il n'y a rien sous lequel descendre.
    if (this.config.bitrate) ceilings.set(this.channels, Math.min(ceilings.get(this.channels) ?? Infinity, this.config.bitrate));
  }

  /**
   * Releases the decoder and the encoder. Safe to call twice.
   *
   * The decoder's close was unguarded while the encoder's was: closing an already-closed decoder
   * throws, and the throw happened *before* the encoder was reached — so a second close, or a
   * close after the decoder had already failed, leaked an encoder that nothing would ever come
   * back for. Both are guarded now, and each is only ever asked once.
   */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    void this.generator?.return?.(undefined);
    try {
      this.decoder.close();
    } catch {
      // Already closed by an error it reported earlier.
    }
    try {
      this.encoder.close();
    } catch {
      // Likewise.
    }
  }
}

function toBytes(source: BufferSource): ArrayBuffer {
  return source instanceof ArrayBuffer ? source.slice(0) : source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength);
}

function toFrame(chunk: EncodedAudioChunk): TranscodedFrame {
  const data = new Uint8Array(chunk.byteLength);
  chunk.copyTo(data);
  return { data, timestampUs: chunk.timestamp, durationUs: chunk.duration ?? 0 };
}

/**
 * Ramène des plans décodés au nombre de canaux que l'encodeur accepte.
 *
 * L'ordre des canaux d'un flux AC-3/E-AC3 est L R C LFE Ls Rs Lrs Rrs. Passer d'un 7.1 à un 5.1
 * revient donc à replier les deux canaux arrière sur les deux canaux d'ambiance ; le coefficient
 * de 0,707 (soit 1/√2) est celui qui conserve la puissance en additionnant deux sources
 * décorrélées, et non leur amplitude — additionner brutalement saturerait.
 *
 * Le repli vers deux canaux est la matrice de mixage ITU-R BS.775, celle qu'appliquent les
 * décodeurs matériels : le centre et l'ambiance entrent à −3 dB dans chaque côté, la basse
 * fréquence est écartée plutôt que sommée, où elle ne ferait que de la boue.
 */
/**
 * Les dispositions dont on connaît le rang de chaque canal.
 *
 * Tout ce qui suit — le repli comme le complément — lit les plans à des rangs fixes : L R C LFE
 * Ls Rs Lrs Rrs. Ce n'est vrai que de ces comptes-là. Relevé sur cette bibliothèque le
 * 19/09/2026, 1 462 pistes : 1 ch × 15, 2 ch × 208, 3 ch × 2, **5 ch × 2**, 6 ch × 1 113,
 * **7 ch × 2**, 8 ch × 120.
 *
 * Les six pistes à 5 et 7 canaux sont celles qui n'entrent dans aucun modèle, et pour une raison
 * de fond : le nombre ne dit pas la disposition. Cinq canaux, c'est un 5.0 — L R C Ls Rs, sans
 * caisson — chez « Mamma Mia! », et un 4.1 — L R C LFE Cs — chez « Point Break ». Sept, c'est un
 * 6.1 dont le rang 4 est un arrière central là où le modèle attend une ambiance gauche. Le
 * décodeur ne rend que le compte, jamais la disposition : mediabunny n'expose que
 * `numberOfChannels`, vérifié dans son interface.
 *
 * Trois canaux entrent dans le modèle parce que les trois premiers rangs sont les mêmes partout.
 */
const KNOWN_LAYOUTS = new Set([1, 2, 3, 6, 8]);

/** Le plus petit compte à disposition connue qui contient celui-ci — 5 → 6, 7 → 8. */
export function knownLayoutAtLeast(channels: number): number {
  if (KNOWN_LAYOUTS.has(channels)) return channels;
  return [...KNOWN_LAYOUTS].find((known) => known > channels) ?? 8;
}

/**
 * Le coefficient de demi-puissance, écrit exactement.
 *
 * `0.707` traînait ici quand l'autre repli — celui du canevas — utilisait `Math.SQRT1_2`. Le
 * commentaire du repli disait pourtant « 0,707, soit 1/√2 » : c'était la même intention notée deux
 * fois, arrondie d'un côté. Un écart de 10⁻⁴, inaudible, mais c'est exactement le genre de
 * divergence silencieuse qui fait dire à un test qu'un des deux chemins a changé.
 */
const HALF_POWER = Math.SQRT1_2;

/**
 * Ce que l'on peut affirmer d'une disposition inconnue : ses trois premiers canaux.
 *
 * Toutes celles qu'on croise ici — 5.0, 4.1, 6.1 — commencent par avant gauche, avant droit,
 * centre. Au-delà, les rangs divergent, et les lire quand même revient à envoyer une ambiance
 * droite dans le caisson ou un arrière central dans l'oreille gauche. On garde donc les trois
 * premiers et on laisse le reste : perdre l'ambiance de six pistes sur mille quatre cent
 * soixante-deux vaut mieux que la déplacer sur toutes.
 */
function frontOnly(planes: Float32Array[]): Float32Array[] {
  return planes.slice(0, 3);
}

export function fold(planes: Float32Array[], to: number): Float32Array[] {
  const from = planes.length;
  // Ramenée à ce qu'on sait d'elle avant toute chose : la suite lit des rangs, et une disposition
  // inconnue ne les respecte pas. Voir `frontOnly`. Avant même le cas « rien à changer » : un
  // 4.1 envoyé tel quel à un encodeur qui accepte cinq canaux — l'Opus de Firefox — était lu en
  // 5.0, le caisson dans l'ambiance gauche (relu le 24/09/2026).
  if (!KNOWN_LAYOUTS.has(from)) return fold(frontOnly(planes), to);
  if (to === from) return planes;

  /**
   * Compléter vers le haut : les canaux qui manquent sont ajoutés silencieux, à leur place.
   *
   * Ça n'a rien d'un remixage — il n'y a rien à inventer. L'ordre des canaux est celui que le
   * repli ci-dessous lit déjà : L R C LFE Ls Rs Lrs Rrs. Passer d'un 5.1 à un 7.1 revient donc à
   * ajouter les deux arrières, et un mixage 5.1 n'a par définition aucun contenu à y mettre : les
   * six premiers sortent des mêmes enceintes qu'avant, les deux dernières se taisent.
   *
   * C'est ce qui permet d'unifier la disposition d'un fichier vers le **haut** : la piste la plus
   * riche garde tous ses canaux, et c'est la plus pauvre qui s'adapte — sans rien perdre non plus.
   */
  if (to > from) {
    const frames = planes[0]?.length ?? 0;
    const silence = (count: number) => Array.from({ length: count }, () => new Float32Array(frames));
    /**
     * Le mono est une exception, et elle s'entend.
     *
     * Complété comme les autres, un unique plan devient le canal avant *gauche* et rien d'autre :
     * l'ordre est L R C LFE Ls Rs, et un fichier mono n'a qu'un plan. Le navigateur replie ensuite
     * ce 5.1 en stéréo par la matrice habituelle — droite = R + 0,707·C + 0,707·Rs — dont chaque
     * terme est nul. On obtenait donc un film entier dans une seule oreille.
     *
     * Un mono se copie dans les deux canaux avant, ce que fait tout décodeur : c'est un centre
     * fantôme, à niveau égal des deux côtés, et le repli du navigateur le rend au centre. Le cas
     * n'a rien de théorique — la piste française par défaut de « L'Exorciste » est un mix mono,
     * et l'unification de ce fichier porte toutes ses pistes à six canaux.
     */
    if (from === 1) return [planes[0], planes[0], ...silence(to - 2)];
    return [...planes, ...silence(to - from)];
  }
  const [L, R, C, , Ls, Rs, Lrs, Rrs] = planes;
  /**
   * La somme se fait en double précision, puis se range en simple.
   *
   * Écrite plan par plan dans le tampon de sortie, chaque addition arrondissait au format 32 bits
   * avant la suivante : un repli 5.1 → stéréo, qui somme trois termes, s'écartait de 8·10⁻⁵ du
   * résultat exact. Inaudible — quelque chose comme −81 dB —, mais gratuit à éviter, et c'est ce
   * qu'un test de repli du canevas mesurait déjà sans que personne n'ait à le demander.
   */
  const mix = (...parts: [Float32Array | undefined, number][]) => {
    const out = new Float32Array(planes[0].length);
    for (let i = 0; i < out.length; i++) {
      let sum = 0;
      for (const [plane, gain] of parts) if (plane) sum += plane[i] * gain;
      out[i] = sum;
    }
    return out;
  };

  if (from === 8 && to === 6) {
    return [L, R, C, planes[3], mix([Ls, HALF_POWER], [Lrs, HALF_POWER]), mix([Rs, HALF_POWER], [Rrs, HALF_POWER])];
  }
  if (to === 2) {
    const back = from >= 8 ? [[Lrs, 0.5], [Rrs, 0.5]] : [];
    return [
      mix([L, 1], [C, HALF_POWER], [Ls, HALF_POWER], ...(back.slice(0, 1) as [Float32Array | undefined, number][])),
      mix([R, 1], [C, HALF_POWER], [Rs, HALF_POWER], ...(back.slice(1, 2) as [Float32Array | undefined, number][])),
    ];
  }
  // Une disposition qu'on ne sait pas replier proprement : on garde les premiers canaux plutôt
  // que d'inventer une matrice, ce qui vaut toujours mieux qu'un silence.
  return planes.slice(0, to);
}

/**
 * L'ordre des canaux que l'AAC attend, à partir de celui que le décodeur rend.
 *
 * Les deux ne rangent pas leurs canaux pareil, et personne ne le disait ici. Le décodeur rend
 * l'ordre WAVE — L R C LFE Ls Rs, celui que `fold` lit déjà juste au-dessus. L'AAC multicanal,
 * lui, met le centre en premier et le LFE en dernier : C L R Ls Rs LFE.
 *
 * Entrelacés sans permutation, les plans gardaient leur rang et changeaient de sens : le centre,
 * c'est-à-dire les dialogues, arrivait au rang du canal droit. Au casque, sur un 5.1 replié en
 * stéréo par le navigateur, ça donnait les voix uniquement à droite et la musique à gauche.
 * Rapporté sur « Titanic », vérifié à l'oreille, et absent du lecteur Jellyfin — qui transcode
 * côté serveur avec ffmpeg, lequel fait cette correspondance depuis toujours.
 *
 * La stéréo n'a rien à permuter : L et R sont au même rang dans les deux conventions. C'est
 * pourquoi seuls les fichiers multicanaux étaient touchés — c'est-à-dire presque toute cette
 * bibliothèque.
 */
/**
 * **Rien à permuter pour l'AAC, et c'est une mesure, pas un raisonnement.**
 *
 * Cette table existait et rangeait les plans dans l'ordre du *train binaire* AAC — centre devant,
 * LFE derrière. Le raisonnement était juste sur le format et faux sur l'interface : on ne donne
 * pas un train binaire à `AudioEncoder`, on lui donne un `AudioData`, dont l'ordre des canaux est
 * celui, standard, de l'API Web Audio — L R C LFE Ls Rs. C'est l'encodeur qui fait la conversion
 * vers son format. Permuter avant lui, c'est l'appliquer deux fois.
 *
 * Mesuré le 19/09/2026 pour en avoir le cœur net, plan par plan, sur vingt secondes de dialogue :
 *
 * | plan | notre décodeur | ffmpeg (ordre WAVE) |
 * |------|----------------|---------------------|
 * | 0    | −29,13 dB      | −29,12 dB (L)       |
 * | 1    | −30,12 dB      | −30,11 dB (R)       |
 * | 2    | **−23,11 dB**  | −23,10 dB (**C**)   |
 * | 3    | −40,64 dB      | −40,63 dB (LFE)     |
 * | 4    | −33,90 dB      | −33,89 dB (Ls)      |
 * | 5    | −34,05 dB      | −34,05 dB (Rs)      |
 *
 * Identique à deux décimales, sur « Twilight » en E-AC3 comme sur « Titanic » en AC-3. Le
 * décodeur rend donc exactement ce que l'encodeur attend, et la permutation déplaçait le centre
 * au rang que l'encodeur lit comme le canal gauche : replié en stéréo, tout le dialogue partait
 * dans l'oreille gauche. C'est le défaut rapporté au casque sur Chrome, sur les deux pistes d'un
 * même film.
 *
 * On ne remet pas cette table sans une mesure de bout en bout — la précédente a été écrite sur un
 * raisonnement, et elle a tenu neuf jours.
 */
const AAC_ORDER: Record<number, readonly number[]> = {};

/**
 * **Mais l'encodeur d'Apple, lui, ne convertit pas** — et les deux mesures étaient vraies, chacune
 * sur son navigateur. Réconcilié le 21/09/2026.
 *
 * Le 07/09, « Titanic » sur **iPhone** (AC-3 et E-AC3 mêlés, donc ré-encodés) : les voix à droite,
 * corrigé par la permutation vers l'ordre AAC. Le 19/09, un spectateur sur **Chrome/Windows** : le
 * son d'un seul côté, corrigé en la retirant — le commit disait « un iPhone ne passe jamais par
 * ici », ce qui est faux pour le DTS, le TrueHD, le FLAC et tout fichier mixte. Et la mesure qui
 * le justifiait portait sur notre *décodeur*, pas sur les encodeurs. Le 21/09, Braveheart en VO
 * TrueHD 7.1 sur iPhone : les voix plus fortes à droite.
 *
 * La raison : l'encodeur AAC d'Apple (AudioToolbox) lit les plans dans l'ordre du format —
 * centre d'abord, LFE à la fin — quand on ne lui donne pas de disposition, et personne ne lui en
 * donne. WebKit (`AudioEncoderCocoa`) ne lui transmet que le nombre de canaux ; **Chrome sur macOS
 * non plus** — lu dans son code (`AudioToolboxAudioEncoder` : « We don't setup the AudioConverter
 * channel layout here »), le 21/09/2026. Ailleurs, l'encodeur de la plateforme prend l'ordre
 * standard : Media Foundation sous Windows (confirmé à l'oreille), l'AAC d'Android (Chrome passe
 * par MediaCodec sans masque de canaux ; l'encodeur logiciel d'Android est réglé en ordre WAVE —
 * lu, pas mesuré).
 *
 * D'où cette table, pour tout navigateur sur un système Apple : le 5.1 et le trois canaux dans
 * l'ordre AAC. Pas de huit canaux : `chooseTranscodePlan` n'en demande jamais à cet encodeur (voir
 * `appleAacCap`).
 */
const APPLE_AAC_ORDER: Record<number, readonly number[]> = {
  // [L,R,C] → [C,L,R]
  3: [2, 0, 1],
  // [L,R,C,LFE,Ls,Rs] → [C,L,R,Ls,Rs,LFE]
  6: [2, 0, 1, 4, 5, 3],
};

/**
 * Au plus six canaux vers l'encodeur AAC d'Apple.
 *
 * L'AAC n'a pas de vrai 7.1 à enceintes arrière — sa configuration 7, celle que l'iPhone produit,
 * est un « 7.1 larges avant » —, l'encodeur d'Apple ne dit pas où il range huit plans, et aucune
 * mesure n'existe ici pour le savoir. Un 7.1 est donc replié en 5.1 avant lui (`fold`, les arrières
 * mêlés aux ambiances), dans l'ordre qui, lui, a été entendu juste sur « Titanic ». Sur un iPhone —
 * haut-parleurs, casque, audio spatial —, rien n'est perdu que deux canaux qu'aucune sortie n'a.
 */
function appleAacCap(codec: string): number {
  return codec === TARGET_CODEC && appleAudioToolbox() ? 6 : Infinity;
}

/**
 * L'AAC sera-t-il encodé par AudioToolbox, l'encodeur d'Apple ? Oui sur tout système Apple, quel
 * que soit le navigateur : Safari, tout navigateur iOS (WebKit), Chrome sur macOS. iPadOS se
 * présente comme un Mac, ce qui tombe juste. Une question de système et non de moteur : c'est
 * l'encodeur de la plateforme qui décide, et Chrome sur Mac utilise le même.
 */
export function appleAudioToolbox(): boolean {
  if (typeof navigator === "undefined") return false;
  const agent = navigator.userAgent ?? "";
  return /iPhone|iPad|iPod|Macintosh|Mac OS X/.test(agent) && !/Android/.test(agent);
}

/**
 * **Opus : rien à permuter non plus — mesuré le 21/09/2026.**
 *
 * Une table rangeait les plans dans l'ordre Vorbis (L C R Ls Rs LFE), le même raisonnement que
 * celui qui avait trompé pour l'AAC, gardé faute de mesure. La mesure est faite : Firefox — le
 * seul navigateur ici qui encode de l'Opus multicanal — a encodé un 5.1 et un 7.1 dont chaque
 * canal portait sa fréquence, et ffmpeg, décodeur de référence, les a rendus. Avec la table, le
 * centre ressortait à droite et le LFE dans une ambiance ; sans elle, chaque fréquence revient à
 * sa place. L'encodeur de Firefox (libopus) convertit lui-même depuis l'ordre standard, comme
 * celui de Chrome pour l'AAC. Seul celui d'Apple ne convertit pas (voir `APPLE_AAC_ORDER`).
 */
/** La disposition attendue par le codec de destination, ou rien si on ne la connaît pas. */
function orderFor(codec: string): Record<number, readonly number[]> | null {
  if (codec.startsWith("mp4a.")) return appleAudioToolbox() ? APPLE_AAC_ORDER : AAC_ORDER;
  return null;
}

/**
 * Remet les plans dans l'ordre du codec de destination.
 *
 * Rendus tels quels quand il n'y a rien à faire, ce qui est désormais le cas de l'AAC pour tous
 * les comptes de canaux — voir `AAC_ORDER`. Et aussi : la stéréo et le mono, dont L et R sont au
 * même rang partout ; un codec dont on ne connaît pas la convention ; un nombre de canaux
 * qu'aucune table ne décrit — quadriphonie, 5.0. On préfère alors ne pas permuter que permuter au
 * hasard : un ordre inconnu laissé tel quel est un pari, un ordre inventé est une faute.
 */
export function toCodecChannelOrder(planes: Float32Array[], codec: string): Float32Array[] {
  const table = orderFor(codec);
  const order = table?.[planes.length];
  if (!order) return planes;
  return order.map((from) => planes[from]);
}

/** Interleaves the decoder's planes, which is the layout an encoder takes. */
function encode(encoder: AudioEncoder, decoded: DecodedAudio, outChannels: number | undefined, codec: string): void {
  const folded = outChannels ? fold(decoded.planes, outChannels) : decoded.planes;
  // Après le repli, jamais avant : `fold` raisonne en ordre WAVE, comme le décodeur.
  const planes = toCodecChannelOrder(folded, codec);
  const channels = planes.length;
  const frames = planes[0]?.length ?? 0;
  if (frames === 0) return;

  const interleaved = new Float32Array(frames * channels);
  for (let channel = 0; channel < channels; channel++) {
    const plane = planes[channel];
    for (let i = 0; i < frames; i++) interleaved[i * channels + channel] = plane[i];
  }

  const data = new AudioData({
    format: "f32",
    sampleRate: decoded.sampleRate,
    numberOfFrames: frames,
    numberOfChannels: channels,
    timestamp: Math.round(decoded.timestampSeconds * 1e6),
    data: interleaved,
  });
  encoder.encode(data);
  data.close();
}
