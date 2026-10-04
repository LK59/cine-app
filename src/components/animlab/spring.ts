// Le ressort de la page « Tests animations » : un oscillateur amorti, échantillonné en images clés.
//
// Les animations de la page passent par `element.animate()` sur `transform` : le compositeur les
// joue seul, sans le fil principal. Un ressort calculé image par image en JavaScript aurait
// redonné la main au fil principal à chaque image — précisément ce qu'on veut éviter là où le
// TrueHD se décode. On simule donc le ressort *une fois*, au moment du geste, et on remet au
// navigateur la suite des positions : soixante images clés par seconde, interpolées linéairement.

export type SpringParams = {
  /** Raideur (k). Plus elle est haute, plus le ressort est vif. */
  stiffness: number;
  /** Amortissement (c). Bas : ça oscille ; vers 2·√k : ça se pose sans dépasser. */
  damping: number;
};

export type SpringSample = { t: number; x: number; v: number };

const STEP = 1 / 120;
const SAMPLE_EVERY = 2; // une image clé toutes les deux sous-étapes : 60 par seconde
const MAX_SECONDS = 2.5;

/**
 * La trajectoire d'un ressort de masse 1 qui part de `from` (vitesse `velocity`, en unités par
 * seconde) et revient vers `to`. Intégration semi-implicite, assez fine pour qu'un dépassement de
 * quelques pour cent ne dépende pas du pas. S'arrête quand le ressort est posé — position et
 * vitesse sous le millième de l'écart de départ — ou au bout de deux secondes et demie.
 */
export function simulateSpring(from: number, to: number, params: SpringParams, velocity = 0): SpringSample[] {
  const span = Math.max(Math.abs(to - from), 1e-3);
  let x = from;
  let v = velocity;
  const samples: SpringSample[] = [{ t: 0, x, v }];
  let step = 0;
  for (let t = STEP; t <= MAX_SECONDS; t += STEP) {
    const a = -params.stiffness * (x - to) - params.damping * v;
    v += a * STEP;
    x += v * STEP;
    step += 1;
    const settled = Math.abs(x - to) < span * 1e-3 && Math.abs(v) < span * 1e-2;
    if (step % SAMPLE_EVERY === 0 || settled) samples.push({ t, x: settled ? to : x, v: settled ? 0 : v });
    if (settled) break;
  }
  const last = samples[samples.length - 1];
  if (last.x !== to) samples.push({ t: last.t + STEP, x: to, v: 0 });
  return samples;
}

/**
 * Les images clés d'un ressort, prêtes pour `element.animate(keyframes, { duration, easing: "linear" })`.
 * `frame` traduit chaque échantillon en style — `scale`, une translation, un étirement selon la vitesse.
 */
export function springKeyframes(
  from: number,
  to: number,
  params: SpringParams,
  frame: (sample: SpringSample) => Keyframe,
  velocity = 0,
): { keyframes: Keyframe[]; duration: number } {
  const samples = simulateSpring(from, to, params, velocity);
  const end = samples[samples.length - 1].t;
  return {
    keyframes: samples.map((s) => ({ ...frame(s), offset: end > 0 ? s.t / end : 1 })),
    duration: end * 1000,
  };
}

/** Le plus grand dépassement, en fraction de l'écart : 0,08 = le ressort passe 8 % au-delà. */
export function springOvershoot(params: SpringParams): number {
  const samples = simulateSpring(0, 1, params);
  return Math.max(0, ...samples.map((s) => s.x - 1));
}
