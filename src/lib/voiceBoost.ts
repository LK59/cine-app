"use client";

import { useCallback, useEffect, useRef, useState, type RefObject } from "react";

/**
 * « Voix claires » — sonde v1, administrateur seulement (11/10/2026).
 *
 * Le son du lecteur natif passe par Web Audio juste avant les haut-parleurs : une matrice qui
 * remonte le canal central d'un 5.1 (ou le centre d'une stéréo), un égaliseur sur la bande des
 * voix, et un compresseur qui rapproche dialogues et explosions. Les octets livrés au `<video>`
 * ne changent pas.
 *
 * Ce qui en fait une sonde et pas une fonction : `createMediaElementSource` est sans retour. Une
 * fois appelé, tout le son de l'élément passe par l'AudioContext pour la vie de l'élément — « éteint »
 * n'est donc plus le chemin d'origine mais un contournement dans le graphe. D'où trois règles :
 * rien n'est attaché tant que personne n'a appuyé (un compte qui n'y touche pas garde exactement
 * le chemin d'avant) ; l'attache se fait dans le geste (iOS refuse de démarrer un AudioContext
 * hors geste — il resterait muet) ; et l'état n'est pas retenu d'une séance à l'autre, pour
 * qu'aucune ouverture n'attache le graphe sans geste.
 *
 * Ce que la sonde doit établir, par navigateur : le son passe-t-il encore (Safari peut rendre
 * muette une source MediaSource), combien de canaux arrivent (6 = le vrai renfort du centre),
 * la latence ajoutée, et ce qui survit à l'arrière-plan et à AirPlay. Le relevé (`VoiceBoostDiag`)
 * est affiché dans le sous-menu pour être lu à l'écran.
 */

export type VoiceBoostMode = "off" | "voices" | "night";

/** Ce que l'oreille reçoit, déduit des niveaux mesurés par canal. */
export type SourceLayout = "unknown" | "mono" | "stereo" | "surround";

/**
 * Gains de la matrice vers la stéréo de sortie :
 *   G = L·front + R·cross + C·center + Ls·surround   (et symétrique pour D)
 * LFE est toujours coupé : le grave des explosions est précisément ce qui couvre les voix le soir.
 */
export interface MixGains {
  front: number;
  cross: number;
  center: number;
  surround: number;
}

/**
 * La matrice selon ce qui arrive et le mode. Contournement (`off`) : un mélange neutre — la stéréo
 * telle quelle, le 5.1 replié comme le ferait le navigateur (−3 dB centre et arrières).
 * En stéréo, renforcer le centre se fait par mid/side : la voix est au milieu, l'ambiance sur les
 * côtés ; front 0,95 / cross 0,25 revient à mid ×1,2, side ×0,7.
 */
export function mixGains(layout: SourceLayout, mode: VoiceBoostMode): MixGains {
  if (layout === "mono") return { front: 1, cross: 1, center: 0, surround: 0 };
  if (layout === "surround") {
    if (mode === "off") return { front: 1, cross: 0, center: 0.707, surround: 0.707 };
    return { front: 0.7, cross: 0, center: mode === "night" ? 1.5 : 1.3, surround: 0.45 };
  }
  // stéréo, ou pas encore mesuré : la stéréo est le cas de loin le plus courant, et ces gains
  // laissent passer un 5.1 encore inconnu sans rien perdre (seulement sans renfort).
  if (mode === "off") return { front: 1, cross: 0, center: 0.707, surround: 0.707 };
  return { front: 0.95, cross: 0.25, center: 0.707, surround: 0.5 };
}

/** Déduit la disposition des niveaux RMS des canaux L R C LFE Ls Rs (seuil de présence). */
export function layoutFromLevels(levels: number[]): SourceLayout {
  const on = (i: number) => (levels[i] ?? 0) > 0.0005;
  if (on(2) || on(4) || on(5)) return "surround";
  if (on(0) && on(1)) return "stereo";
  if (on(0)) return "mono";
  return "unknown";
}

export interface VoiceBoostDiag {
  state: string;
  sampleRate: number;
  latencyMs: number | null;
  layout: SourceLayout;
  /** Niveau par canal, en dBFS arrondi (−∞ → null), dans l'ordre L R C LFE Ls Rs. */
  levelsDb: (number | null)[];
  /** Niveau en sortie de graphe : la preuve que le son passe encore. */
  outDb: number | null;
}

interface Graph {
  ctx: AudioContext;
  matrix: { l: GainNode[]; r: GainNode[] };
  eq: BiquadFilterNode[];
  comp: DynamicsCompressorNode;
  makeup: GainNode;
  analysers: AnalyserNode[];
  outAnalyser: AnalyserNode;
}

// Un graphe par élément, pour la vie de l'élément : `createMediaElementSource` lève une erreur au
// second appel sur le même élément.
const graphs = new WeakMap<HTMLMediaElement, Graph>();

function buildGraph(video: HTMLMediaElement): Graph {
  const Ctor: typeof AudioContext =
    window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const ctx = new Ctor({ latencyHint: "playback" });
  const source = ctx.createMediaElementSource(video);
  const splitter = ctx.createChannelSplitter(6);
  source.connect(splitter);

  const merger = ctx.createChannelMerger(2);
  // Un gain par (canal d'entrée → sortie). Entrées : 0 L, 1 R, 2 C, 3 LFE (non routé), 4 Ls, 5 Rs.
  const l: GainNode[] = [];
  const r: GainNode[] = [];
  for (const ch of [0, 1, 2, 4, 5]) {
    const gl = ctx.createGain();
    const gr = ctx.createGain();
    splitter.connect(gl, ch);
    splitter.connect(gr, ch);
    gl.connect(merger, 0, 0);
    gr.connect(merger, 0, 1);
    l.push(gl);
    r.push(gr);
  }

  // Égaliseur des voix : moins de grave boueux, présence à 1 et 3 kHz.
  const low = ctx.createBiquadFilter();
  low.type = "lowshelf";
  low.frequency.value = 180;
  const mid = ctx.createBiquadFilter();
  mid.type = "peaking";
  mid.frequency.value = 1000;
  mid.Q.value = 0.9;
  const pres = ctx.createBiquadFilter();
  pres.type = "peaking";
  pres.frequency.value = 3000;
  pres.Q.value = 1;
  const comp = ctx.createDynamicsCompressor();
  const makeup = ctx.createGain();
  merger.connect(low).connect(mid).connect(pres).connect(comp).connect(makeup).connect(ctx.destination);

  const analysers: AnalyserNode[] = [];
  for (let ch = 0; ch < 6; ch++) {
    const a = ctx.createAnalyser();
    a.fftSize = 2048;
    splitter.connect(a, ch);
    analysers.push(a);
  }
  const outAnalyser = ctx.createAnalyser();
  outAnalyser.fftSize = 2048;
  makeup.connect(outAnalyser);

  return { ctx, matrix: { l, r }, eq: [low, mid, pres], comp, makeup, analysers, outAnalyser };
}

function applyMode(g: Graph, layout: SourceLayout, mode: VoiceBoostMode) {
  const m = mixGains(layout, mode);
  const t = g.ctx.currentTime;
  const set = (p: AudioParam, v: number) => p.setTargetAtTime(v, t, 0.05);
  // Ordre des gains : L, R, C, Ls, Rs — G reçoit L·front + R·cross, D l'inverse.
  const [lL, lR, lC, lLs, lRs] = g.matrix.l;
  const [rL, rR, rC, rLs, rRs] = g.matrix.r;
  set(lL.gain, m.front);
  set(lR.gain, m.cross);
  set(lC.gain, m.center);
  set(lLs.gain, m.surround);
  set(lRs.gain, 0);
  set(rR.gain, m.front);
  set(rL.gain, m.cross);
  set(rC.gain, m.center);
  set(rRs.gain, m.surround);
  set(rLs.gain, 0);

  const [low, mid, pres] = g.eq;
  const on = mode !== "off";
  set(low.gain, on ? -4 : 0);
  set(mid.gain, on ? 2 : 0);
  set(pres.gain, on ? 5 : 0);
  // Éteint, le compresseur ne doit rien faire : seuil à 0 dB, rapport 1.
  set(g.comp.threshold, mode === "night" ? -36 : mode === "voices" ? -26 : 0);
  set(g.comp.ratio, mode === "night" ? 8 : mode === "voices" ? 3 : 1);
  set(g.comp.knee, 10);
  g.comp.attack.value = 0.005;
  g.comp.release.value = 0.25;
  set(g.makeup.gain, mode === "night" ? 1.9 : mode === "voices" ? 1.4 : 1);
}

function rmsDb(a: AnalyserNode, buf: Float32Array): { rms: number; db: number | null } {
  a.getFloatTimeDomainData(buf);
  let s = 0;
  for (let i = 0; i < buf.length; i++) s += buf[i] * buf[i];
  const rms = Math.sqrt(s / buf.length);
  return { rms, db: rms > 0.00001 ? Math.round(20 * Math.log10(rms)) : null };
}

export interface VoiceBoostControl {
  mode: VoiceBoostMode;
  setMode: (mode: VoiceBoostMode) => void;
  diag: VoiceBoostDiag | null;
  /** Message de la dernière erreur d'attache (affiché tel quel : c'est une sonde). */
  error: string | null;
}

/**
 * La commande du lecteur natif. `available` faux : rien n'est jamais créé.
 * Le relevé est rafraîchi deux fois par seconde tant que le graphe existe — la disposition mesurée
 * réajuste la matrice (un 5.1 reconnu passe aux gains du centre).
 */
export function useVoiceBoost(videoRef: RefObject<HTMLVideoElement | null>, available: boolean): VoiceBoostControl | undefined {
  const [mode, setModeState] = useState<VoiceBoostMode>("off");
  const [diag, setDiag] = useState<VoiceBoostDiag | null>(null);
  const [error, setError] = useState<string | null>(null);
  const modeRef = useRef<VoiceBoostMode>("off");
  const layoutRef = useRef<SourceLayout>("unknown");
  const [attached, setAttached] = useState(false);
  // L'élément réellement attaché, pour fermer son contexte au démontage — et seulement là : un
  // nettoyage lié aux dépendances d'un effet détruisait le graphe d'un élément encore vivant.
  const attachedVideo = useRef<HTMLVideoElement | null>(null);

  const setMode = useCallback(
    (next: VoiceBoostMode) => {
      const video = videoRef.current;
      if (!video) return;
      try {
        let g = graphs.get(video);
        if (!g) {
          if (next === "off") return; // jamais attaché : « éteint » est déjà le chemin d'origine
          g = buildGraph(video);
          graphs.set(video, g);
          attachedVideo.current = video;
          setAttached(true);
        }
        modeRef.current = next;
        applyMode(g, layoutRef.current, next);
        // Dans le geste : iOS ne démarre un AudioContext qu'ici.
        void g.ctx.resume();
        setModeState(next);
        setError(null);
      } catch (e) {
        setError(e instanceof Error ? `${e.name}: ${e.message}` : String(e));
      }
    },
    [videoRef]
  );

  useEffect(() => {
    if (!attached) return;
    const video = videoRef.current;
    const g = video ? graphs.get(video) : undefined;
    if (!video || !g) return;
    const buf = new Float32Array(2048);
    // Un contexte suspendu par le système (arrière-plan, appel, verrouillage) rend l'élément muet :
    // on le relance à la reprise de la lecture et au retour au premier plan.
    const wake = () => {
      if (g.ctx.state !== "running") void g.ctx.resume();
    };
    video.addEventListener("play", wake);
    document.addEventListener("visibilitychange", wake);
    const tick = window.setInterval(() => {
      const levels = g.analysers.map((a) => rmsDb(a, buf));
      const layout = video.paused ? layoutRef.current : layoutFromLevels(levels.map((x) => x.rms));
      if (layout !== "unknown" && layout !== layoutRef.current) {
        layoutRef.current = layout;
        applyMode(g, layout, modeRef.current);
      }
      const lat = (g.ctx.baseLatency ?? 0) + ((g.ctx as AudioContext & { outputLatency?: number }).outputLatency ?? 0);
      setDiag({
        state: g.ctx.state,
        sampleRate: g.ctx.sampleRate,
        latencyMs: lat > 0 ? Math.round(lat * 1000) : null,
        layout: layoutRef.current,
        levelsDb: levels.map((x) => x.db),
        outDb: rmsDb(g.outAnalyser, buf).db,
      });
    }, 500);
    return () => {
      window.clearInterval(tick);
      video.removeEventListener("play", wake);
      document.removeEventListener("visibilitychange", wake);
    };
  }, [attached, videoRef]);

  // Au démontage du lecteur, qui emporte l'élément avec lui : sans fermeture, le contexte survivrait
  // (un par film ouvert).
  useEffect(
    () => () => {
      const video = attachedVideo.current;
      const g = video ? graphs.get(video) : undefined;
      if (!video || !g) return;
      graphs.delete(video);
      void g.ctx.close();
    },
    []
  );

  if (!available) return undefined;
  return { mode, setMode, diag, error };
}
