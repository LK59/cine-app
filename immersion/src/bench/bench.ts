import { Vector2, Vector3, type PerspectiveCamera, type WebGLRenderer } from "three";
import { api } from "../lib/session";
import { SUPERSAMPLING, QUALITY, type Quality } from "../lib/settings";
import { dispatch } from "../media/commands";
import { playTestClip } from "../media/playback";
import { useStore } from "../state/store";

/**
 * « Mesurer » : ce que cette machine tient, chiffré.
 *
 * Un parcours de caméra **fixe** de vingt secondes dans la grande pièce — toujours le même, pour que
 * deux machines ou deux versions se comparent —, joué pour chaque préréglage, d'abord écrans éteints
 * puis avec une vidéo. Pour chaque passage : la cadence moyenne et le « 1 % le plus lent » (ce que
 * l'œil retient d'une saccade), le nom de la carte graphique donné par le navigateur et la définition
 * réellement rendue. Chaque passage part au journal du serveur (`startup.log`,
 * `kind: "immersion-bench"`) : c'est avec ces lignes que les préréglages se règlent, pas à l'estime.
 */
export interface BenchResult {
  preset: Quality;
  video: boolean;
  fps: number;
  low1: number;
  width: number;
  height: number;
}

/** La durée d'un passage, et le temps laissé au préréglage pour se mettre en place. Les tests les raccourcissent. */
export const timing = { seconds: 20, settleMs: 1800 };
const PRESETS: Quality[] = ["ultra", "high", "medium", "low"];

/** Le parcours : où sont les yeux, ce qu'ils regardent, à cinq instants ; entre eux, une courbe. */
const PATH: { eye: [number, number, number]; target: [number, number, number] }[] = [
  { eye: [-1.2, 1.64, 3.1], target: [1.5, 2.6, -5] },
  { eye: [-3.4, 1.64, -1.2], target: [5.4, 2.3, -1.8] },
  { eye: [0.2, 1.64, -4.4], target: [0.4, 3.4, -7.2] },
  { eye: [2.6, 1.64, 0.6], target: [-3.2, 0.9, -2.6] },
  { eye: [0.4, 1.64, 3.2], target: [1.3, 1.5, 9] },
];
const eyes = PATH.map((p) => new Vector3(...p.eye));
const targets = PATH.map((p) => new Vector3(...p.target));
const scratch = new Vector3();

/** Catmull-Rom entre les points du parcours, extrémités tenues. */
function along(points: Vector3[], t: number, out: Vector3): Vector3 {
  const span = points.length - 1;
  const x = Math.min(0.9999, Math.max(0, t)) * span;
  const i = Math.floor(x);
  const u = x - i;
  const p0 = points[Math.max(0, i - 1)];
  const p1 = points[i];
  const p2 = points[i + 1];
  const p3 = points[Math.min(span, i + 2)];
  const c = (a: number, b: number, d: number, e: number) => 0.5 * (2 * b + (d - a) * u + (2 * a - 5 * b + 4 * d - e) * u * u + (3 * b - a - 3 * d + e) * u * u * u);
  return out.set(c(p0.x, p1.x, p2.x, p3.x), c(p0.y, p1.y, p2.y, p3.y), c(p0.z, p1.z, p2.z, p3.z));
}

/**
 * Ce que la boucle de rendu lit : tant qu'un passage est en cours, la caméra suit le parcours (voir
 * `Player.tsx`) et chaque image est chronométrée (`BenchProbe`).
 */
export const benchRun = {
  active: false,
  /** Le début du passage, sur l'horloge de `performance.now()`. */
  startedAt: 0,
  frames: [] as number[],
  last: 0,
  /** Le moteur de rendu, déposé par `BenchProbe`. */
  gl: null as WebGLRenderer | null,
};

/** Pose la caméra sur le parcours. Renvoie la position des yeux. */
export function benchPose(camera: PerspectiveCamera, now: number): Vector3 {
  const t = (now - benchRun.startedAt) / (timing.seconds * 1000);
  along(eyes, t, camera.position);
  camera.lookAt(along(targets, t, scratch));
  return camera.position;
}

/** Une image vient d'être rendue. */
export function benchFrame(now: number): void {
  if (!benchRun.active) return;
  if (benchRun.last) benchRun.frames.push(now - benchRun.last);
  benchRun.last = now;
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
let cancelled = false;

export function cancelBench(): void {
  cancelled = true;
}

function rendererName(gl: WebGLRenderer): { renderer: string | null; vendor: string | null } {
  try {
    const context = gl.getContext();
    const info = context.getExtension("WEBGL_debug_renderer_info");
    if (!info) return { renderer: String(context.getParameter(context.RENDERER)), vendor: String(context.getParameter(context.VENDOR)) };
    return { renderer: String(context.getParameter(info.UNMASKED_RENDERER_WEBGL)), vendor: String(context.getParameter(info.UNMASKED_VENDOR_WEBGL)) };
  } catch {
    return { renderer: null, vendor: null };
  }
}

/** Une mire animée en 1080p, faite sur place : de quoi mesurer « avec vidéo » sans lancer un film. */
function testStream(): { stream: MediaStream; stop: () => void } {
  const canvas = document.createElement("canvas");
  canvas.width = 1920;
  canvas.height = 1080;
  const context = canvas.getContext("2d")!;
  let frame = 0;
  const timer = setInterval(() => {
    const t = frame++ / 30;
    for (let i = 0; i < 8; i++) {
      context.fillStyle = `hsl(${(i * 45 + t * 40) % 360} 70% ${35 + 20 * Math.sin(t + i)}%)`;
      context.fillRect(i * 240, 0, 240, 1080);
    }
    context.fillStyle = "#fff";
    context.fillRect(((t * 300) % 2120) - 200, 480, 200, 120);
  }, 1000 / 30);
  const stream = canvas.captureStream(30);
  return {
    stream,
    stop: () => {
      clearInterval(timer);
      stream.getTracks().forEach((track) => track.stop());
    },
  };
}

async function pass(preset: Quality, video: boolean, gl: WebGLRenderer, run: string, videoSource: "film" | "mire" | null): Promise<BenchResult | null> {
  const store = useStore.getState();
  store.setBench({ preset, video, progress: 0 });
  // Le temps que le préréglage se mette en place : ombres, programmes, taille du rendu.
  await wait(timing.settleMs);
  if (cancelled) return null;
  benchRun.frames = [];
  benchRun.last = 0;
  benchRun.startedAt = performance.now();
  benchRun.active = true;
  for (let elapsed = 0; elapsed < timing.seconds * 1000 && !cancelled; elapsed = performance.now() - benchRun.startedAt) {
    useStore.getState().setBench({ progress: elapsed / (timing.seconds * 1000) });
    await wait(Math.min(250, timing.seconds * 100));
  }
  benchRun.active = false;
  if (cancelled) return null;
  const frames = benchRun.frames.slice().sort((a, b) => b - a);
  if (frames.length < 10) return null;
  const total = frames.reduce((sum, ms) => sum + ms, 0);
  const slowest = frames.slice(0, Math.max(1, Math.round(frames.length / 100)));
  const fps = (frames.length / total) * 1000;
  const low1 = 1000 / (slowest.reduce((sum, ms) => sum + ms, 0) / slowest.length);
  // La cadence de l'écran, à peu près : celle des images les plus rapides.
  const hz = Math.round(1000 / frames[Math.floor(frames.length * 0.95)]);
  const size = gl.getDrawingBufferSize(new Vector2());
  const { renderer, vendor } = rendererName(gl);
  const settings = useStore.getState().settings;
  const result: BenchResult = { preset, video, fps, low1, width: size.x, height: size.y };
  // Au journal : une ligne par passage. Un envoi qui échoue ne retire rien au résultat affiché.
  void api("/api/viewport-diag", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      kind: "immersion-bench",
      run,
      preset,
      video,
      videoSource,
      videoHeight: video ? (document.querySelector("video")?.videoHeight ?? null) : null,
      fps,
      low1,
      frames: frames.length,
      seconds: total / 1000,
      hz,
      renderer,
      vendor,
      width: size.x,
      height: size.y,
      cssWidth: window.innerWidth,
      cssHeight: window.innerHeight,
      dpr: window.devicePixelRatio || 1,
      scale: QUALITY[preset].scale * (settings.supersampling ? SUPERSAMPLING : 1),
      supersampling: settings.supersampling,
      baked: useStore.getState().baked,
      build: __ASSETS_VERSION__,
    }),
  }).catch(() => undefined);
  return result;
}

/** Lance la mesure complète : chaque préréglage, écrans éteints puis avec vidéo. Environ trois minutes. */
export async function runBench(): Promise<void> {
  const store = useStore.getState();
  const gl = benchRun.gl;
  if (!gl || store.bench?.running) return;
  cancelled = false;
  const run = Math.random().toString(36).slice(2, 14);
  const before = store.playback;
  const film = before.status === "playing" || before.status === "paused";
  store.setBench({ running: true, results: [], preset: null, video: false, progress: 0, step: 0, steps: PRESETS.length * 2 });
  const results: BenchResult[] = [];
  let mire: ReturnType<typeof testStream> | null = null;
  try {
    for (const video of [false, true]) {
      if (video) {
        // Avec vidéo : le film en cours s'il y en a un — c'est son décodage qu'on veut compter —, sinon une mire.
        if (film) dispatch({ type: "play" });
        else {
          mire = testStream();
          await playTestClip(mire.stream);
        }
      } else if (film) dispatch({ type: "pause" });
      for (const preset of PRESETS) {
        if (cancelled) return;
        useStore.getState().setBench({ step: results.length + 1 });
        const result = await pass(preset, video, gl, run, video ? (film ? "film" : "mire") : null);
        if (result) {
          results.push(result);
          useStore.getState().setBench({ results: results.slice() });
        }
      }
    }
  } finally {
    benchRun.active = false;
    if (mire) {
      mire.stop();
      dispatch({ type: "stop" });
    } else if (film) dispatch({ type: before.wantPaused ? "pause" : "play" });
    useStore.getState().setBench({ running: false, preset: null, progress: 0 });
  }
}
