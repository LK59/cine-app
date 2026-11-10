import { AudioContext as ThreeAudioContext, AudioListener, PositionalAudio } from "three";

/**
 * Le son du chalet.
 *
 * Le film sort de la télévision : la piste du `<video>` entre dans le graphe Web Audio
 * (`createMediaElementSource`) et passe par un `PositionalAudio` accroché à l'écran — atténuation
 * avec la distance, cône tourné vers la pièce, panoramique selon l'orientation de la tête. Deux
 * choses s'y ajoutent : un passe-bas qui étouffe le son quand un mur sépare le visiteur de l'écran,
 * et une réverbération courte, dont la réponse impulsionnelle est fabriquée ici.
 *
 *   vidéo ──► passe-bas ──► panoramique ──► gain ──┬──────────────► maître ──► sortie
 *     │                                            └─► convolution ─► dosage ─┘
 *     └──────────────► direct (spatialisation coupée) ─────────────────────┘
 *
 * Une fois la piste entrée dans le graphe, **tout** le son de la vidéo passe par lui : le volume et
 * le silence se règlent donc sur le gain maître, jamais sur l'élément.
 */
interface Graph {
  context: AudioContext;
  listener: AudioListener;
  /** Le haut-parleur de la télévision : à accrocher à l'écran. */
  tv: PositionalAudio;
  /** Le vent : à accrocher à la baie. */
  wind: PositionalAudio;
  /** Le crépitement des bougies : à accrocher au lustre. */
  candles: PositionalAudio;
  lowpass: BiquadFilterNode;
  direct: GainNode;
  wet: GainNode;
  connected: WeakSet<HTMLMediaElement>;
}

let graph: Graph | null = null;

/** Une réponse impulsionnelle de pièce : du bruit qui s'éteint, quelques premières réflexions, des aigus qui tombent plus vite. */
function impulseResponse(context: AudioContext, seconds = 1.25): AudioBuffer {
  const rate = context.sampleRate;
  const length = Math.floor(rate * seconds);
  const buffer = context.createBuffer(2, length, rate);
  for (let channel = 0; channel < 2; channel++) {
    const data = buffer.getChannelData(channel);
    let smoothed = 0;
    for (let i = 0; i < length; i++) {
      const t = i / rate;
      // Le bois et les tissus absorbent : une décroissance rapide, sans queue métallique.
      const envelope = Math.exp(-t * 5.2);
      const white = Math.random() * 2 - 1;
      // Un passe-bas qui se ferme avec le temps : les aigus meurent les premiers.
      const k = 0.25 + 0.7 * Math.min(1, t / seconds);
      smoothed += (white - smoothed) * (1 - k);
      data[i] = smoothed * envelope;
    }
    // Les premières réflexions : le sol, le mur de pierre, le plafond — décalées d'une oreille à l'autre.
    for (const [ms, gain] of [
      [11, 0.5],
      [19, 0.38],
      [31, 0.3],
      [47, 0.2],
    ]) {
      const at = Math.floor(((ms + channel * 3) / 1000) * rate);
      if (at < length) data[at] += gain * (channel === 0 ? 1 : -1) * 0.6;
    }
  }
  return buffer;
}

/** Un bruit brun en boucle : la matière du vent. */
function windBuffer(context: AudioContext): AudioBuffer {
  const rate = context.sampleRate;
  const length = rate * 6;
  const buffer = context.createBuffer(1, length, rate);
  const data = buffer.getChannelData(0);
  let last = 0;
  for (let i = 0; i < length; i++) {
    last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02;
    // Les rafales : une enveloppe lente, qui se referme sur elle-même pour boucler sans clic.
    const gust = 0.55 + 0.45 * Math.sin((i / length) * Math.PI * 2) * Math.sin((i / length) * Math.PI * 6 + 1);
    data[i] = last * 3.2 * gust;
  }
  return buffer;
}

/** De rares petits claquements : une mèche qui grésille. */
function crackleBuffer(context: AudioContext): AudioBuffer {
  const rate = context.sampleRate;
  const length = rate * 7;
  const buffer = context.createBuffer(1, length, rate);
  const data = buffer.getChannelData(0);
  let seed = 7;
  const random = () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
  for (let n = 0; n < 26; n++) {
    const at = Math.floor(random() * (length - 2000));
    const strength = 0.25 + random() * 0.75;
    const size = 40 + Math.floor(random() * 220);
    for (let i = 0; i < size; i++) data[at + i] += (random() * 2 - 1) * strength * Math.exp(-i / (size * 0.22));
  }
  return buffer;
}

/**
 * Crée le graphe (une fois). Le contexte naît suspendu tant qu'aucun geste n'a eu lieu : c'est le
 * clic d'entrée qui le réveille (`resumeAudio`).
 */
export function audio(): Graph {
  if (graph) return graph;
  const Context = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const context = new Context({ latencyHint: "playback" });
  // three garde un contexte partagé : c'est celui-ci qu'il doit prendre.
  ThreeAudioContext.setContext(context);
  const listener = new AudioListener();

  const tv = new PositionalAudio(listener);
  tv.setRefDistance(5.5);
  tv.setRolloffFactor(1.35);
  tv.setDistanceModel("inverse");
  // Plein son devant l'écran, moitié moins sur les côtés et derrière.
  tv.setDirectionalCone(150, 250, 0.4);
  const lowpass = context.createBiquadFilter();
  lowpass.type = "lowpass";
  lowpass.frequency.value = 20000;
  lowpass.Q.value = 0.5;
  tv.setFilters([lowpass]);

  const convolver = context.createConvolver();
  convolver.buffer = impulseResponse(context);
  const wet = context.createGain();
  wet.gain.value = 0;
  tv.gain.connect(convolver);
  convolver.connect(wet);
  wet.connect(listener.getInput());

  const direct = context.createGain();
  direct.gain.value = 0;
  direct.connect(listener.getInput());

  const loop = (buffer: AudioBuffer, volume: number, refDistance: number, filter?: BiquadFilterNode) => {
    const sound = new PositionalAudio(listener);
    sound.setBuffer(buffer);
    sound.setLoop(true);
    sound.setRefDistance(refDistance);
    sound.setRolloffFactor(1.2);
    sound.setVolume(volume);
    if (filter) sound.setFilters([filter]);
    return sound;
  };
  const band = context.createBiquadFilter();
  band.type = "bandpass";
  band.frequency.value = 420;
  band.Q.value = 0.45;
  const wind = loop(windBuffer(context), 0.5, 3.5, band);
  const high = context.createBiquadFilter();
  high.type = "highpass";
  high.frequency.value = 1800;
  const candles = loop(crackleBuffer(context), 0.16, 2.5, high);

  graph = { context, listener, tv, wind, candles, lowpass, direct, wet, connected: new WeakSet() };
  return graph;
}

/** À appeler dans un geste de l'utilisateur : réveille le contexte et lance l'ambiance. */
export function resumeAudio(): void {
  const g = audio();
  void g.context.resume().catch(() => {});
  for (const sound of [g.wind, g.candles]) if (!sound.isPlaying) sound.play();
}

/** Fait entrer la piste d'une vidéo dans le graphe. Une seule fois par élément : le navigateur l'exige. */
export function connectVideo(video: HTMLMediaElement): void {
  const g = audio();
  if (g.connected.has(video)) return;
  g.connected.add(video);
  const source = g.context.createMediaElementSource(video);
  g.tv.setNodeSource(source as unknown as AudioBufferSourceNode);
  source.connect(g.direct);
}

export interface Mix {
  volume: number;
  muted: boolean;
  spatial: boolean;
  /** 0 à 1. */
  reverb: number;
}

/** Applique les réglages : volume maître, spatialisation, part de réverbération. */
export function applyMix(mix: Mix): void {
  if (!graph) return;
  const { context, listener, tv, direct, wet } = graph;
  const now = context.currentTime;
  listener.gain.gain.setTargetAtTime(mix.muted ? 0 : mix.volume, now, 0.03);
  tv.gain.gain.setTargetAtTime(mix.spatial ? 1 : 0, now, 0.05);
  direct.gain.setTargetAtTime(mix.spatial ? 0 : 0.85, now, 0.05);
  wet.gain.setTargetAtTime(mix.spatial ? mix.reverb * 0.55 : 0, now, 0.05);
}

/**
 * L'acoustique du lieu où se tient le visiteur : `cutoff` étouffe le son de la télévision (un mur
 * entre elle et lui ne laisse passer que les graves).
 */
export function applyAcoustics(cutoff: number): void {
  if (!graph) return;
  graph.lowpass.frequency.setTargetAtTime(cutoff, graph.context.currentTime, 0.18);
}

/** Tout rendre : sons d'ambiance arrêtés, contexte fermé. */
export function disposeAudio(): void {
  if (!graph) return;
  const g = graph;
  graph = null;
  for (const sound of [g.wind, g.candles]) {
    try {
      if (sound.isPlaying) sound.stop();
    } catch {
      // Déjà arrêté.
    }
  }
  void g.context.close().catch(() => {});
}
