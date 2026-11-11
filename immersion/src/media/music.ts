import { PositionalAudio } from "three";
import { assetUrl } from "../lib/assets";
import { audio } from "./audio";

/**
 * La musique d'ambiance de la chaîne hi-fi.
 *
 * Même principe que le son des films : **une** source (un élément `<audio>` qui enchaîne les morceaux)
 * entre dans le graphe, et sort par **un haut-parleur par enceinte** — atténuation avec la distance,
 * filtre quand un mur sépare, portée. La musique vient donc toujours des enceintes, jamais « de
 * partout ».
 *
 * Elle joue bas — c'est un fond —, et se tait d'elle-même quand un film démarre, puis revient.
 */
const TRACKS = ["music/lobby-time.mp4", "music/bossa-antigua.mp4"];
/** Le niveau d'un fond sonore : loin sous celui d'un film. */
const LEVEL = 0.42;

interface Deck {
  element: HTMLAudioElement;
  /** Le gain commun à toutes les enceintes : marche / arrêt, et le silence pendant un film. */
  master: GainNode;
  speakers: Map<string, { sound: PositionalAudio; lowpass: BiquadFilterNode; reach: GainNode }>;
  track: number;
  wanted: boolean;
  quiet: boolean;
}
let deck: Deck | null = null;

function ensure(): Deck {
  if (deck) return deck;
  const graph = audio();
  const element = new Audio();
  element.preload = "none";
  element.crossOrigin = "anonymous";
  const source = graph.context.createMediaElementSource(element);
  const master = graph.context.createGain();
  master.gain.value = 0;
  source.connect(master);
  const created: Deck = { element, master, speakers: new Map(), track: 0, wanted: false, quiet: false };
  // Un morceau fini, le suivant ; au bout de la liste, on recommence.
  element.addEventListener("ended", () => {
    created.track = (created.track + 1) % TRACKS.length;
    element.src = assetUrl(TRACKS[created.track]);
    if (created.wanted && !created.quiet) void element.play().catch(() => undefined);
  });
  deck = created;
  return created;
}

/** Le haut-parleur d'une enceinte, créé à la première demande. */
export function loudspeaker(id: string, loudness: number): PositionalAudio {
  const d = ensure();
  const existing = d.speakers.get(id);
  if (existing) return existing.sound;
  const graph = audio();
  const sound = new PositionalAudio(graph.listener);
  sound.setRefDistance(loudness);
  sound.setRolloffFactor(1.3);
  sound.setDistanceModel("inverse");
  sound.setDirectionalCone(170, 280, 0.5);
  const lowpass = graph.context.createBiquadFilter();
  lowpass.type = "lowpass";
  lowpass.frequency.value = 20000;
  lowpass.Q.value = 0.5;
  const reach = graph.context.createGain();
  sound.setFilters([lowpass, reach]);
  sound.gain.connect(graph.convolver);
  sound.setNodeSource(d.master as unknown as AudioBufferSourceNode);
  d.speakers.set(id, { sound, lowpass, reach });
  return sound;
}

/**
 * Ce que la chaîne doit faire : `on` — elle est en marche ; `quiet` — un film joue, elle se tait.
 * Le son monte et descend en fondu ; l'élément est mis en pause une fois le silence fait.
 */
export function setMusic(on: boolean, quiet: boolean): void {
  const d = ensure();
  if (d.wanted === on && d.quiet === quiet) return;
  d.wanted = on;
  d.quiet = quiet;
  const graph = audio();
  const audible = on && !quiet;
  const now = graph.context.currentTime;
  if (graph.context.state === "running") d.master.gain.setTargetAtTime(audible ? LEVEL : 0, now, audible ? 0.9 : 0.5);
  else d.master.gain.value = audible ? LEVEL : 0;
  if (audible) {
    if (!d.element.src) d.element.src = assetUrl(TRACKS[d.track]);
    void d.element.play().catch(() => undefined);
  } else {
    // Le temps du fondu, puis l'aiguille se lève.
    setTimeout(() => {
      if (deck && !(deck.wanted && !deck.quiet)) deck.element.pause();
    }, 1800);
  }
}

/** La musique s'entend-elle en ce moment ? (La platine tourne quand c'est le cas.) */
/**
 * Dans un salon, la musique part du même endroit chez tous (`net/sync.ts`) : ce morceau, à ce nombre de secondes
 * depuis son départ (au-delà de sa durée, on reprend au début — les morceaux s'enchaînent ensuite chez chacun).
 */
export function cueMusic(track: number, seconds: number): void {
  const d = ensure();
  const index = ((track % TRACKS.length) + TRACKS.length) % TRACKS.length;
  if (d.track !== index || !d.element.src) {
    d.track = index;
    d.element.src = assetUrl(TRACKS[index]);
  }
  const place = () => {
    const duration = d.element.duration;
    d.element.currentTime = Number.isFinite(duration) && duration > 0 ? seconds % duration : seconds;
  };
  if (d.element.readyState >= 1) place();
  else d.element.addEventListener("loadedmetadata", place, { once: true });
}

export function musicPlaying(): boolean {
  return !!deck && deck.wanted && !deck.quiet;
}

/** L'acoustique entre le visiteur et une enceinte : comme pour un écran (`applyAcoustics`). */
export function applyMusicAcoustics(id: string, cutoff: number, reach: number): void {
  const entry = deck?.speakers.get(id);
  if (!deck || !entry) return;
  const graph = audio();
  if (graph.context.state !== "running") {
    entry.lowpass.frequency.value = cutoff;
    entry.reach.gain.value = reach;
    return;
  }
  const now = graph.context.currentTime;
  entry.lowpass.frequency.setTargetAtTime(cutoff, now, 0.18);
  entry.reach.gain.setTargetAtTime(reach, now, 0.12);
}

/** Ce que chaque enceinte laisse passer — pour les tests. */
export function musicLevels(): { id: string; reach: number; cutoff: number; master: number; playing: boolean }[] {
  if (!deck) return [];
  const d = deck;
  return [...d.speakers].map(([id, entry]) => ({ id, reach: entry.reach.gain.value, cutoff: entry.lowpass.frequency.value, master: d.master.gain.value, playing: !d.element.paused }));
}

export function disposeMusic(): void {
  if (!deck) return;
  deck.element.pause();
  deck.element.removeAttribute("src");
  deck = null;
}
