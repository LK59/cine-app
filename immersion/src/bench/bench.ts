import { Vector2, Vector3, type PerspectiveCamera, type WebGLRenderer } from "three";
import { assetUrl } from "../lib/assets";
import { api } from "../lib/session";
import { SUPERSAMPLING, QUALITY, type Quality } from "../lib/settings";
import { dispatch } from "../media/commands";
import { getVideo, playTestClip } from "../media/playback";
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
  /** Pour chaque image, où en était le parcours (0 à 1) : situe les images lentes. */
  at: [] as number[],
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
  if (benchRun.last) {
    benchRun.frames.push(now - benchRun.last);
    benchRun.at.push((now - benchRun.startedAt) / (timing.seconds * 1000));
  }
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

/**
 * La mire de la mesure : un vrai fichier vidéo (1080p, VP9), décodé comme un film. Elle était d'abord
 * dessinée dans la page (un canevas capté en flux) : le dessin, la capture et l'envoi de chaque image à la
 * carte graphique pesaient sur la mesure elle-même — « avec vidéo » comptait surtout le coût de la mire.
 */
const TEST_CLIP = "bench/mire.webm";

async function pass(preset: Quality, video: boolean, gl: WebGLRenderer, run: string, videoSource: "film" | "mire" | null): Promise<BenchResult | null> {
  const store = useStore.getState();
  store.setBench({ preset, video, progress: 0 });
  // Le temps que le préréglage se mette en place : ombres, programmes, taille du rendu.
  await wait(timing.settleMs);
  if (cancelled) return null;
  benchRun.frames = [];
  benchRun.at = [];
  benchRun.last = 0;
  benchRun.startedAt = performance.now();
  benchRun.active = true;
  for (let elapsed = 0; elapsed < timing.seconds * 1000 && !cancelled; elapsed = performance.now() - benchRun.startedAt) {
    useStore.getState().setBench({ progress: elapsed / (timing.seconds * 1000) });
    await wait(Math.min(250, timing.seconds * 100));
  }
  benchRun.active = false;
  if (cancelled) return null;
  // Les à-coups : la pire image, combien dépassent 33 et 50 ms, et où sur le parcours tombent les cinq pires
  // (« 0.42:61 » : à 42 % du parcours, 61 ms). Une moyenne ne dit pas si le « 1 % le plus lent » vient d'un
  // endroit de la maison ou de sursauts réguliers.
  const raw = benchRun.frames;
  const order = raw.map((_, i) => i).sort((a, b) => raw[b] - raw[a]);
  const slowAt = order
    .slice(0, 5)
    .map((i) => `${benchRun.at[i].toFixed(2)}:${Math.round(raw[i])}`)
    .join(";");
  const frames = raw.slice().sort((a, b) => b - a);
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
      videoHeight: video ? getVideo().videoHeight || null : null,
      fps,
      low1,
      frames: frames.length,
      seconds: total / 1000,
      maxMs: frames[0],
      over33: frames.filter((ms) => ms > 33).length,
      over50: frames.filter((ms) => ms > 50).length,
      slowAt,
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
  let mire = false;
  try {
    for (const video of [false, true]) {
      if (video) {
        // Avec vidéo : le film en cours s'il y en a un — c'est son décodage qu'on veut compter —, sinon une mire.
        if (film) dispatch({ type: "play" });
        else {
          mire = true;
          await playTestClip(assetUrl(TEST_CLIP));
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
      dispatch({ type: "stop" });
    } else if (film) dispatch({ type: before.wantPaused ? "pause" : "play" });
    useStore.getState().setBench({ running: false, preset: null, progress: 0 });
  }
}
