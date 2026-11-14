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
 *   vidéo ──► passe-bas ──► portée ──► panoramique ──► gain ──┬──────────────► maître ──► sortie    (par écran)
 *     │                                            └─► convolution ─► dosage ─┘
 *     └──────────────► direct (spatialisation coupée) ─────────────────────┘
 *
 * Il y a **un haut-parleur par écran**, tous branchés en parallèle sur la même source : la même piste,
 * au même instant, sort de chaque télévision avec sa propre atténuation, son propre filtre et sa propre
 * **portée** — au-delà, cet écran ne s'entend plus. Les portées se recouvrent : par endroits on entend
 * deux télévisions à la fois, chacune de son côté, et le son suit de lui-même quand on change de pièce.
 *
 * Une fois la piste entrée dans le graphe, **tout** le son de la vidéo passe par lui : le volume et
 * le silence se règlent donc sur le gain maître, jamais sur l'élément.
 */
interface Graph {
  context: AudioContext;
  listener: AudioListener;
  /** Les haut-parleurs des écrans, par identifiant d'écran : chacun est à accrocher à sa dalle. */
  speakers: Map<string, { sound: PositionalAudio; lowpass: BiquadFilterNode; reach: GainNode }>;
  /** La piste de la vidéo, une fois entrée dans le graphe. */
  source: MediaElementAudioSourceNode | null;
  convolver: ConvolverNode;
  /** Le vent : à accrocher à la baie. */
  wind: PositionalAudio;
  /** Le crépitement des bougies : à accrocher au lustre. */
  candles: PositionalAudio;
  /** Le feu : son ronflement sourd et ses claquements, à accrocher au foyer. */
  fire: PositionalAudio;
  /** Le bouillonnement du bain, sur la terrasse. */
  tub: PositionalAudio;
  /** Ce qui passe du dehors à travers la baie : un passe-bas sur le vent, un autre sur le bain (`setOutdoors`). */
  windMuffle: BiquadFilterNode;
  tubMuffle: BiquadFilterNode;
  /** Le ronronnement du chat. */
  purr: PositionalAudio;
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

/** Le ronronnement : un grave qui vibre vingt-cinq fois par seconde, au rythme lent d'un souffle. */
function purrBuffer(context: AudioContext): AudioBuffer {
  const rate = context.sampleRate;
  const length = rate * 6;
  const buffer = context.createBuffer(1, length, rate);
  const data = buffer.getChannelData(0);
  let seed = 5;
  const random = () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
  let low = 0;
  for (let i = 0; i < length; i++) {
    const t = i / rate;
    low = (low + 0.2 * (random() * 2 - 1)) / 1.2;
    // Deux souffles par boucle : l'inspiration ronronne plus fort que l'expiration.
    const breath = 0.55 + 0.45 * Math.sin((t / 3) * Math.PI * 2);
    const rattle = Math.pow(0.5 + 0.5 * Math.sin(2 * Math.PI * 25 * t), 3);
    data[i] = (Math.sin(2 * Math.PI * 52 * t) * 0.5 + low * 1.4) * rattle * breath;
  }
  return buffer;
}

/** Le bain : un bouillonnement doux — un bruit filtré, piqué de petites bulles. */
function bubbleBuffer(context: AudioContext): AudioBuffer {
  const rate = context.sampleRate;
  const length = rate * 8;
  const buffer = context.createBuffer(1, length, rate);
  const data = buffer.getChannelData(0);
  let seed = 91;
  const random = () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
  let low = 0;
  for (let i = 0; i < length; i++) {
    low = (low + 0.08 * (random() * 2 - 1)) / 1.08;
    data[i] = low * 0.9 * (0.8 + 0.2 * Math.sin((i / length) * Math.PI * 2 * 5));
  }
  // Les bulles : de très courtes notes qui montent.
  for (let n = 0; n < 420; n++) {
    const at = Math.floor(random() * (length - 2400));
    const pitch = 420 + random() * 900;
    const size = 500 + Math.floor(random() * 1500);
    const strength = 0.05 + random() * 0.16;
    for (let i = 0; i < size; i++) {
      const t = i / rate;
      data[at + i] += Math.sin(2 * Math.PI * (pitch + 900 * t * 14) * t) * strength * Math.sin((Math.PI * i) / size);
    }
  }
  return buffer;
}

/** Le feu : un ronflement grave qui ondule, et des claquements secs, serrés, de toutes les forces. */
function fireBuffer(context: AudioContext): AudioBuffer {
  const rate = context.sampleRate;
  const length = rate * 9;
  const buffer = context.createBuffer(1, length, rate);
  const data = buffer.getChannelData(0);
  let seed = 23;
  const random = () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
  let low = 0;
  for (let i = 0; i < length; i++) {
    low = (low + 0.03 * (random() * 2 - 1)) / 1.03;
    // L'enveloppe se referme sur elle-même : la boucle ne s'entend pas.
    const swell = 0.7 + 0.3 * Math.sin((i / length) * Math.PI * 2 * 3);
    data[i] = low * 1.6 * swell;
  }
  for (let n = 0; n < 150; n++) {
    const at = Math.floor(random() * (length - 3000));
    const strength = Math.pow(random(), 2.2) * 0.9 + 0.05;
    const size = 30 + Math.floor(random() * 260);
    for (let i = 0; i < size; i++) data[at + i] += (random() * 2 - 1) * strength * Math.exp(-i / (size * 0.2));
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

  const convolver = context.createConvolver();
  convolver.buffer = impulseResponse(context);
  const wet = context.createGain();
  wet.gain.value = 0;
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
  // Le dehors à travers la baie : sans filtre sur la terrasse, étouffé dedans (`setOutdoors`).
  const muffle = () => {
    const filter = context.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = 20000;
    filter.Q.value = 0.5;
    return filter;
  };
  const windMuffle = muffle();
  const tubMuffle = muffle();
  const wind = loop(windBuffer(context), 0.5, 3.5, band);
  wind.setFilters([band, windMuffle]);
  const high = context.createBiquadFilter();
  high.type = "highpass";
  high.frequency.value = 1800;
  const candles = loop(crackleBuffer(context), 0.16, 2.5, high);

  const fire = loop(fireBuffer(context), 0.55, 1.8);
  fire.gain.connect(convolver);
  const tub = loop(bubbleBuffer(context), TUB, 1.6, tubMuffle);
  const purr = loop(purrBuffer(context), 0.0, 0.5);
  graph = { context, listener, speakers: new Map(), source: null, convolver, wind, candles, fire, tub, windMuffle, tubMuffle, purr, direct, wet, connected: new WeakSet() };
  return graph;
}

/** À appeler dans un geste de l'utilisateur : réveille le contexte et lance l'ambiance. */
export function resumeAudio(): void {
  const g = audio();
  void g.context.resume().catch(() => {});
  for (const sound of [g.wind, g.candles, g.fire, g.tub, g.purr]) if (!sound.isPlaying) sound.play();
}

/**
 * Le haut-parleur d'un écran, créé à la première demande. `loudness` : la distance en deçà de laquelle
 * il joue à plein volume — un grand écran porte plus loin qu'un petit.
 */
export function speaker(id: string, loudness: number): PositionalAudio {
  const g = audio();
  const existing = g.speakers.get(id);
  if (existing) return existing.sound;
  const sound = new PositionalAudio(g.listener);
  sound.setRefDistance(loudness);
  sound.setRolloffFactor(1.35);
  sound.setDistanceModel("inverse");
  // Plein son devant l'écran, moitié moins sur les côtés et derrière.
  sound.setDirectionalCone(150, 250, 0.4);
  const lowpass = g.context.createBiquadFilter();
  lowpass.type = "lowpass";
  lowpass.frequency.value = 20000;
  lowpass.Q.value = 0.5;
  // La portée : un gain propre à ce haut-parleur, fermé quand le visiteur est trop loin de l'écran
  // (`applyAcoustics`). À part du gain de `PositionalAudio`, qui porte le réglage « son spatialisé ».
  const reach = g.context.createGain();
  sound.setFilters([lowpass, reach]);
  sound.gain.connect(g.convolver);
  g.speakers.set(id, { sound, lowpass, reach });
  if (g.source) sound.setNodeSource(g.source as unknown as AudioBufferSourceNode);
  return sound;
}

/** Fait entrer la piste d'une vidéo dans le graphe. Une seule fois par élément : le navigateur l'exige. */
export function connectVideo(video: HTMLMediaElement): void {
  const g = audio();
  if (g.connected.has(video)) return;
  g.connected.add(video);
  const source = g.context.createMediaElementSource(video);
  g.source = source;
  for (const { sound } of g.speakers.values()) sound.setNodeSource(source as unknown as AudioBufferSourceNode);
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
  const { context, listener, speakers, direct, wet } = graph;
  const now = context.currentTime;
  listener.gain.gain.setTargetAtTime(mix.muted ? 0 : mix.volume, now, 0.03);
  for (const { sound } of speakers.values()) sound.gain.gain.setTargetAtTime(mix.spatial ? 1 : 0, now, 0.05);
  direct.gain.setTargetAtTime(mix.spatial ? 0 : 0.85, now, 0.05);
  wet.gain.setTargetAtTime(mix.spatial ? mix.reverb * 0.55 : 0, now, 0.05);
}

/**
 * L'acoustique entre le visiteur et un écran : `cutoff` est la fréquence au-delà de laquelle le son de
 * cet écran ne lui parvient plus (un mur entre eux ne laisse passer que les graves), `reach` ce qu'il
 * reste de ce son à cette distance (1 près de l'écran, 0 hors de sa portée).
 */
export function applyAcoustics(screenId: string, cutoff: number, reach: number): void {
  const entry = graph?.speakers.get(screenId);
  if (!graph || !entry) return;
  // Tant que le contexte dort (avant le premier geste, onglet suspendu), son horloge est arrêtée et une
  // glissade ne partirait jamais : les valeurs sont posées telles quelles, et le son se réveille juste.
  if (graph.context.state !== "running") {
    entry.lowpass.frequency.value = cutoff;
    entry.reach.gain.value = reach;
    return;
  }
  const now = graph.context.currentTime;
  entry.lowpass.frequency.setTargetAtTime(cutoff, now, 0.18);
  entry.reach.gain.setTargetAtTime(reach, now, 0.12);
}

/**
 * Les bruits de fond (le vent, le bain, le feu) pendant un film : en retrait. `value` va de 1 (rien ne joue) à
 * `DUCKED` ; tenu par `SoundScape`, lu ici et par le feu.
 */
export const ambience = { value: 1 };
export const DUCKED = 0.4;
const WIND = 0.6;
/** Le bain à pleine force, sur la terrasse. */
const TUB = 0.3;

/**
 * Ce que le visiteur entend du dehors (le vent, le bain) : `level` de 0 à 1 et `cutoff`, la fréquence au-delà
 * de laquelle rien ne traverse. Une baie close coupe le dehors comme un vrai vitrage — une vingtaine de décibels
 * et presque tous les aigus : il n'en reste qu'un souffle sourd. Glisse en une demi-seconde, le temps que la
 * porte se ferme.
 */
export function setOutdoors({ level, cutoff }: { level: number; cutoff: number }): void {
  if (!graph) return;
  const now = graph.context.currentTime;
  const wind = WIND * level * ambience.value;
  const tub = TUB * level * ambience.value;
  if (graph.context.state !== "running") {
    graph.wind.gain.gain.value = wind;
    graph.tub.gain.gain.value = tub;
    graph.windMuffle.frequency.value = cutoff;
    graph.tubMuffle.frequency.value = cutoff;
    return;
  }
  graph.wind.gain.gain.setTargetAtTime(wind, now, 0.5);
  graph.tub.gain.gain.setTargetAtTime(tub, now, 0.5);
  graph.windMuffle.frequency.setTargetAtTime(cutoff, now, 0.35);
  graph.tubMuffle.frequency.setTargetAtTime(cutoff, now, 0.35);
}

/** Ce qui passe du dehors à cet instant (gain du vent et du bain, coupure du filtre) — pour les tests. */
export function outdoorLevels(): { wind: number; tub: number; cutoff: number } | null {
  if (!graph) return null;
  return { wind: graph.wind.gain.gain.value, tub: graph.tub.gain.gain.value, cutoff: graph.windMuffle.frequency.value };
}

/** Ce que chaque haut-parleur laisse passer à cet instant — pour les tests et le diagnostic. */
export function speakerLevels(): { id: string; reach: number; cutoff: number }[] {
  if (!graph) return [];
  return [...graph.speakers].map(([id, entry]) => ({ id, reach: entry.reach.gain.value, cutoff: entry.lowpass.frequency.value }));
}

/** Tout rendre : sons d'ambiance arrêtés, contexte fermé. */
export function disposeAudio(): void {
  if (!graph) return;
  const g = graph;
  graph = null;
  for (const sound of [g.wind, g.candles, g.fire, g.tub, g.purr]) {
    try {
      if (sound.isPlaying) sound.stop();
    } catch {
      // Déjà arrêté.
    }
  }
  void g.context.close().catch(() => {});
}
