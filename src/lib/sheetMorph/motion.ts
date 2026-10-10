import { toSpring } from "@/lib/liquidGlass/liquid";
import { simulateSpring } from "@/lib/liquidGlass/spring";

/**
 * Le mouvement de l'ouverture des fiches (DECISIONS.md §61) : les fonctions pures, sans DOM.
 *
 * Mis au point sur la page « Tests animations » (lot H, neuf passes, 10/10/2026) et validé tel quel
 * par Louis sur l'iPhone et le Mac. Les vraies fiches (`useSheetMorph`) et la maquette du banc
 * importent ces mêmes fonctions : ce qui a été réglé là-bas est ce qui tourne ici, et les deux ne
 * peuvent plus diverger.
 *
 * Deux choix, chacun payé d'une passe :
 *
 * 1. Rien que des transformations et des opacités, échantillonnées une fois au départ. La découpe
 *    (`clip-path`) qui faisait grandir la carte ne s'anime sur le compositeur ni dans WebKit ni dans
 *    Chromium : une fenêtre qui retarde d'une image sur son contenu, « légèrement moins fluide que le
 *    reste de l'iPhone » sans qu'on sache dire où. La fenêtre est maintenant translatée et étirée
 *    (échelle non uniforme, `overflow: hidden`), son contenu contre-étiré image clé par image clé.
 *    L'ancien moteur ne survit que dans le banc, pour comparer.
 * 2. Le rythme d'UIKit : un ressort amorti critique (aucun rebond) dont la réponse suit la distance
 *    parcourue rapportée à la diagonale de l'écran, 20 % plus vif sur un ordinateur, la fermeture
 *    0,7 fois plus vive. La durée n'est pas une consigne : c'est le temps qu'il met à se poser.
 */

/** Une place à l'écran, en pixels depuis son coin haut gauche. */
export type Box = { x: number; y: number; w: number; h: number };
/** Une transformation de calque (origine en haut à gauche) : translation puis échelle uniforme. */
export type Tf = { tx: number; ty: number; s: number };
/** Les rayons visibles des quatre coins : haut gauche, haut droit, bas droit, bas gauche. */
export type Corners = [number, number, number, number];
/** Tout ce que le trajet montre à un instant : la fenêtre, ses coins, les deux images et leurs opacités. */
export type Pose = { box: Box; corners: Corners; bd: Tf; poster: Tf; bdOpacity: number; posterOpacity: number };
/**
 * Un mouvement : la progression spatiale `q` (0 → 1, un ressort lancé peut dépasser un rien) au
 * temps donné, sa vitesse en progression par seconde, et sa durée réelle.
 */
export type Motion = { duration: number; q: (ms: number) => number; v: (ms: number) => number; label: string };
/**
 * L'appareil dont on imite le comportement : son ressort (l'ordinateur plus vif), ses gestes (le
 * doigt sur le téléphone et l'iPad, le clavier et la souris sur l'ordinateur).
 */
export type MotionProfile = "phone" | "ipad" | "desktop";
export type Stage = { W: number; H: number };

export const IDENTITY: Tf = { tx: 0, ty: 0, s: 1 };

/**
 * La réponse du ressort selon la distance : 0,22 s pour un trajet nul, 0,34 s pour la diagonale de
 * l'écran. 0,32 → 0,5 s se lisait « trop lent » sur l'iPhone, même variable — un ressort amorti
 * critique de réponse 0,5 s met ~740 ms à se poser (huitième passe).
 */
export const APPLE_RESPONSE = { min: 0.22, max: 0.34 };
/** L'ordinateur : le même ressort, 20 % plus vif à distance égale — macOS l'est plus qu'iOS. */
export const DESKTOP_RESPONSE_RATIO = 0.8;
/** La fermeture : le même ressort, plus vif (0,75 jusqu'à la huitième passe). */
export const CLOSE_RESPONSE_RATIO = 0.7;
/** « Posé » : à moins d'un demi-pixel de l'arrivée, pour de bon. */
export const SETTLE_PX = 0.5;
/** Les vitesses de départ prises au doigt ou à un trajet interrompu, bornées (progression par seconde). */
export const MAX_START_VELOCITY = 25;
/**
 * Le contenu part quand le trajet en est là — en distance, pas en temps.
 *
 * À 0,6, 60 % du trajet est couvert en ~100 ms avec le ressort amorti, et la colonne (logo, infos,
 * Lire, synopsis) se posait pendant que l'image volait encore : double exposition sur l'accueil au
 * bureau, texte sur la bannière en mouvement au téléphone (septième passe). À 90 %, l'image est pour
 * l'œil arrivée.
 */
export const REVEAL_AT = 0.9;
/**
 * Le contenu arrive d'un seul bloc — opacité et 8 px de montée en 160 ms. La cascade d'avant (logo,
 * puis infos, puis Lire…) se lisait « une chose après l'autre, pas tout à fait fluide » (cinquième
 * passe) ; à 220 ms le bloc traînait derrière le ressort accéléré (huitième passe).
 */
export const REVEAL_MS = 160;
export const REVEAL_RISE_PX = 8;
/** L'effacement du contenu à la fermeture, depuis l'opacité où il en est. */
export const CONTENT_OUT_MS = 100;
/** L'assombrissement de ce qui est derrière la fiche, et le recul de l'accueil du bureau. */
export const DIM = 0.6;
export const HOME_SCALE = 0.98;
/**
 * Le relais final de la fermeture : la vraie carte reparaît sous le calque du trajet, qui s'efface
 * par-dessus en ce temps-là — pas de bascule de visibilité qui se voie.
 */
export const HANDOVER_MS = 120;
/**
 * La sortie sans trajet, quand l'affiche d'où la fiche était partie n'est plus à l'écran : la fiche
 * descend un peu en s'effaçant.
 */
export const PLAIN_OUT_MS = 220;
export const PLAIN_OUT_DROP = 48;
/**
 * Une fermeture interrompue par une autre ouverture : son calque de retour s'efface en ce temps-là —
 * ou disparaît d'un coup, presque arrivé (`GHOST_SNAP_AT` du trajet).
 */
export const GHOST_FADE_MS = 80;
export const GHOST_SNAP_AT = 0.85;
/** « Réduire les animations » : un fondu simple, rien qui se déplace. */
export const FADE_IN_MS = 200;
export const FADE_OUT_MS = 180;

export const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
export const lerp = (a: number, b: number, q: number) => a + (b - a) * q;
/** 0 avant `e0`, 1 après `e1`, une marche douce entre les deux. */
export function smooth(e0: number, e1: number, x: number): number {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
}
export const lerpBox = (a: Box, b: Box, q: number): Box => ({ x: lerp(a.x, b.x, q), y: lerp(a.y, b.y, q), w: lerp(a.w, b.w, q), h: lerp(a.h, b.h, q) });
export const lerpTf = (a: Tf, b: Tf, q: number): Tf => ({ tx: lerp(a.tx, b.tx, q), ty: lerp(a.ty, b.ty, q), s: lerp(a.s, b.s, q) });
export const lerpCorners = (a: Corners, b: Corners, q: number): Corners =>
  [Math.max(0, lerp(a[0], b[0], q)), Math.max(0, lerp(a[1], b[1], q)), Math.max(0, lerp(a[2], b[2], q)), Math.max(0, lerp(a[3], b[3], q))];
export const uniformCorners = (r: number): Corners => [r, r, r, r];
export const tfCss = (t: Tf) => `translate(${t.tx.toFixed(2)}px, ${t.ty.toFixed(2)}px) scale(${t.s.toFixed(5)})`;

/** La transformation qui fait couvrir `into` à un calque posé sur `at`, proportions gardées. */
export function coverTf(at: Box, into: Box): Tf {
  const s = Math.max(into.w / Math.max(1, at.w), into.h / Math.max(1, at.h));
  return { tx: into.x + into.w / 2 - (s * at.w) / 2 - at.x, ty: into.y + into.h / 2 - (s * at.h) / 2 - at.y, s };
}

/** Le chemin d'un trajet en pixels : les centres qui se déplacent, plus la moitié de l'écart des diagonales. */
export function travelOf(a: Box, b: Box): number {
  const centre = Math.hypot(b.x + b.w / 2 - (a.x + a.w / 2), b.y + b.h / 2 - (a.y + a.h / 2));
  return centre + Math.abs(Math.hypot(b.w, b.h) - Math.hypot(a.w, a.h)) / 2;
}

/**
 * Le ressort amorti critique d'UIKit et de SwiftUI (`dampingFraction: 1`), lancé à la vitesse `v0`.
 * Forme exacte, pas d'intégration : x(t) = 1 + (−1 + (v0 − ω)t)·e^(−ωt), ω = 2π / réponse. Sa durée
 * est le temps qu'il met à rester à moins de `SETTLE_PX` de l'arrivée sur un trajet de `travelPx`.
 */
export function criticalSpring(response: number, v0: number, travelPx: number): Motion {
  const w = (2 * Math.PI) / response;
  const at = (ms: number) => {
    const t = ms / 1000;
    return 1 + (-1 + (v0 - w) * t) * Math.exp(-w * t);
  };
  const speed = (ms: number) => {
    const t = ms / 1000;
    return Math.exp(-w * t) * (v0 - w * (v0 - w) * t);
  };
  const px = Math.max(1, travelPx);
  let last = 0;
  for (let ms = 0; ms <= 3000; ms += 1) if (Math.abs(1 - at(ms)) * px >= SETTLE_PX) last = ms;
  const duration = Math.max(17, last + 1);
  return {
    duration,
    q: (ms) => (ms >= duration ? 1 : at(Math.max(0, ms))),
    v: (ms) => (ms >= duration ? 0 : speed(Math.max(0, ms))),
    label: `ressort amorti, réponse ${response.toFixed(2).replace(".", ",")} s`,
  };
}

/** Une courbe de Bézier CSS, en fonction : Newton, puis la dichotomie si Newton ne converge pas. */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number): (x: number) => number {
  const bx = (t: number) => ((1 - 3 * x2 + 3 * x1) * t + (3 * x2 - 6 * x1)) * t * t + 3 * x1 * t;
  const by = (t: number) => ((1 - 3 * y2 + 3 * y1) * t + (3 * y2 - 6 * y1)) * t * t + 3 * y1 * t;
  const dx = (t: number) => 3 * (1 - 3 * x2 + 3 * x1) * t * t + 2 * (3 * x2 - 6 * x1) * t + 3 * x1;
  return (x) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let t = x;
    for (let i = 0; i < 8; i++) {
      const err = bx(t) - x;
      if (Math.abs(err) < 1e-6) return by(t);
      const d = dx(t);
      if (Math.abs(d) < 1e-6) break;
      t -= err / d;
    }
    let lo = 0;
    let hi = 1;
    t = x;
    for (let i = 0; i < 30; i++) {
      if (bx(t) < x) lo = t;
      else hi = t;
      t = (lo + hi) / 2;
    }
    return by(t);
  };
}

/** Les courbes à durée fixe que le banc garde pour comparer au ressort. */
export type FixedEase = "spring" | "emphasized" | "easeOut";

/** L'ancien « Ressort Apple » à durée fixe (amortissement 0,86), comme fonction de 0 → 1. */
let springShapeCache: ((p: number) => number) | null = null;
function springShape(): (p: number) => number {
  if (springShapeCache) return springShapeCache;
  const samples = simulateSpring(0, 1, toSpring(1, 0.86));
  const end = samples[samples.length - 1].t || 1;
  springShapeCache = (p) => {
    const t = clamp(p, 0, 1) * end;
    let i = 1;
    while (i < samples.length - 1 && samples[i].t < t) i++;
    const a = samples[i - 1];
    const b = samples[i];
    return lerp(a.x, b.x, b.t > a.t ? (t - a.t) / (b.t - a.t) : 1);
  };
  return springShapeCache;
}

/** Une durée fixe sur l'une des trois courbes — le banc seulement, pour comparer au ressort. */
export function fixedMotion(ease: FixedEase, ms: number): Motion {
  const f = ease === "spring" ? springShape() : ease === "emphasized" ? cubicBezier(0.2, 0, 0, 1) : cubicBezier(0.33, 1, 0.68, 1);
  const q = (t: number) => (t >= ms ? 1 : f(Math.max(0, t) / ms));
  return {
    duration: ms,
    q,
    v: (t) => (q(t + 4) - q(Math.max(0, t - 4))) * (1000 / 8),
    label: `durée fixe, ${ease === "spring" ? "ressort" : ease === "emphasized" ? "accentuée" : "décélération douce"}`,
  };
}

/**
 * La réponse du ressort pour ce trajet : la distance rapportée à la diagonale de l'écran (jamais en
 * pixels bruts — une affiche à mi-hauteur se comporte pareil sur un téléphone, un iPad et un 27
 * pouces), plus vive d'un cinquième sur un ordinateur.
 */
export function appleResponse(from: Box, to: Box, stage: Stage, profile: MotionProfile): number {
  const n = clamp(travelOf(from, to) / Math.max(1, Math.hypot(stage.W, stage.H)), 0, 1);
  return lerp(APPLE_RESPONSE.min, APPLE_RESPONSE.max, n) * (profile === "desktop" ? DESKTOP_RESPONSE_RATIO : 1);
}

/** L'ouverture : `v0` garde la vitesse d'une fermeture retournée (négative : elle allait encore vers l'affiche). */
export function appleOpenMotion(from: Box, to: Box, stage: Stage, profile: MotionProfile, v0 = 0): Motion {
  return criticalSpring(appleResponse(from, to, stage, profile), clamp(v0, -MAX_START_VELOCITY, MAX_START_VELOCITY), travelOf(from, to));
}

/** La fermeture : le même ressort, `CLOSE_RESPONSE_RATIO` fois plus vif, lancé à `v0`. */
export function appleCloseMotion(from: Box, to: Box, stage: Stage, profile: MotionProfile, v0 = 0): Motion {
  return criticalSpring(
    CLOSE_RESPONSE_RATIO * appleResponse(from, to, stage, profile),
    clamp(v0, -MAX_START_VELOCITY, MAX_START_VELOCITY),
    travelOf(from, to),
  );
}

export type Sample = { offset: number; q: number };

/** Les instants échantillonnés d'un mouvement : au moins 60, une par image à 120 Hz au-delà, la dernière à l'arrivée exacte. */
export function sampleMotion(m: Motion): Sample[] {
  const n = Math.min(120, Math.max(60, Math.ceil(m.duration / (1000 / 120))));
  return Array.from({ length: n + 1 }, (_, i) => ({ offset: i / n, q: i === n ? 1 : m.q((i / n) * m.duration) }));
}

/**
 * Le fond de la carte du téléphone, à part : il monte du bas *sous* l'image qui vole, sur le même
 * ressort, pendant que le contenu de la fiche reste à sa place et paraît à 90 % du trajet — la
 * structure de la maquette validée (lot H, neuvième passe), où rien n'avait à se coller.
 *
 * Deux portages l'avaient perdue. Le premier (8.31.0) mettait l'image *sous* toute la fiche et
 * faisait monter la fiche entière : la bande d'encre entre la bannière qui grandit et la carte qui
 * monte se voyait — « le reste de la fiche vient du bas et se colle » (Louis, iPhone, 8.31.2). Le
 * second (8.31.3) collait la fiche entière au bas de l'image, image clé par image clé : plus d'écart,
 * mais un bloc rigide qui « arrive sèchement » (Louis, 8.31.4). Avec l'image au-dessus du fond qui
 * monte, l'écart ne peut plus se voir, et la carte retrouve son propre mouvement.
 *
 * `fromY` / `toY` : le décalage vertical du fond (0 posé ; la hauteur de la carte : tout entier
 * sous l'écran).
 */
export function cardRiseTrack(samples: Sample[], fromY: number, toY: number): Keyframe[] {
  return samples.map(({ offset, q }) => ({ offset, transform: `translateY(${lerp(fromY, toY, q).toFixed(2)}px)` }));
}

/**
 * Le contenu du téléphone (logo, infos, Lire, résumé) porté par la carte : la même piste que son fond
 * (`cardRiseTrack`), et une opacité qui monte de 55 à 95 % du trajet, en espace parcouru — lisible en
 * se posant, entière au repos. Posé à sa place pendant que le fond montait encore, puis révélé à 90 %,
 * il arrivait détaché de sa carte et de la bannière (« le décalage de l'arrivée du contenu, c'est
 * bizarre », Louis sur iPhone, 10/10/2026).
 */
export const CONTENT_RIDE = { from: 0.55, to: 0.95 } as const;

/** L'opacité du contenu porté à ce point du trajet — voir `CONTENT_RIDE`. */
export function contentRideOpacity(q: number): number {
  return smooth(CONTENT_RIDE.from, CONTENT_RIDE.to, q);
}

/** La piste du contenu porté : celle du fond de la carte, avec son opacité. */
export function contentRideTrack(samples: Sample[], fromY: number, toY: number): Keyframe[] {
  return samples.map(({ offset, q }) => ({
    offset,
    transform: `translateY(${lerp(fromY, toY, q).toFixed(2)}px)`,
    opacity: Number(contentRideOpacity(clamp(q, 0, 1)).toFixed(4)),
  }));
}

/**
 * La croix posée sur la bannière (son verre) : elle paraît de 30 à 95 % du trajet, en espace parcouru
 * — comme dans la maquette, où elle ne surgissait pas, pleine, sur une image encore en vol.
 */
export const GLASS_IN = { from: 0.3, to: 0.95, minMs: 160 } as const;

/** Le premier instant (en ms) où le trajet atteint `q`. */
export function timeAt(samples: Sample[], duration: number, q: number): number {
  const hit = samples.find((x) => x.q >= q);
  return (hit?.offset ?? 1) * duration;
}

/**
 * Les poses de l'ouverture : de la carte touchée (`from`, ses coins) au visuel de la fiche (`to`,
 * les siens). L'affiche s'efface sur les premiers 60 % du trajet, le visuel paraît de 10 à 70 % —
 * en espace parcouru, pas en temps : avec un ressort, l'essentiel du trajet tient dans le premier
 * tiers, et un fondu calé sur le temps se serait étiré avec la fin du ressort.
 */
export function openPoses(from: Box, fromCorners: Corners, to: Box, toCorners: Corners): { start: Pose; end: Pose; at: (q: number) => Pose } {
  const start: Pose = { box: from, corners: fromCorners, bd: coverTf(to, from), poster: IDENTITY, bdOpacity: 0, posterOpacity: 1 };
  const end: Pose = { box: to, corners: toCorners, bd: IDENTITY, poster: coverTf(from, to), bdOpacity: 1, posterOpacity: 0 };
  return {
    start,
    end,
    at: (q) => ({
      box: lerpBox(start.box, end.box, q),
      corners: lerpCorners(start.corners, end.corners, q),
      bd: lerpTf(start.bd, end.bd, q),
      poster: lerpTf(start.poster, end.poster, q),
      bdOpacity: smooth(0.1, 0.7, q),
      posterOpacity: 1 - smooth(0, 0.6, q),
    }),
  };
}

/** La pose d'arrivée d'un retour : la carte, l'affiche pleine, le visuel réduit à elle et éteint. */
export function sourcePose(source: Box, sourceCorners: Corners, target: Box): Pose {
  return { box: source, corners: sourceCorners, bd: coverTf(target, source), poster: IDENTITY, bdOpacity: 0, posterOpacity: 1 };
}

/** La pose du visuel posé à sa place, l'affiche agrandie à lui et éteinte : le point de départ d'un retour. */
export function settledPose(target: Box, corners: Corners, source: Box): Pose {
  return { box: target, corners, bd: IDENTITY, poster: coverTf(source, target), bdOpacity: 1, posterOpacity: 0 };
}

/**
 * Les poses d'un retour, depuis où en est la fenêtre (`cur` : la bannière à sa place, tirée au doigt,
 * ou le point d'un aller interrompu). Les deux images se chevauchent sur presque tout le chemin —
 * l'affiche de 15 à 80 %, la bannière de 25 à 90 % —, chacune depuis l'opacité où elle en est : un
 * changement trop soudain à la fin se lisait sur l'iPhone (quatrième passe).
 */
export function closePoses(cur: Pose, to: Pose): (r: number) => Pose {
  return (r) => ({
    box: lerpBox(cur.box, to.box, r),
    corners: lerpCorners(cur.corners, to.corners, r),
    bd: lerpTf(cur.bd, to.bd, r),
    poster: lerpTf(cur.poster, to.poster, r),
    posterOpacity: lerp(cur.posterOpacity, 1, smooth(0.15, 0.8, r)),
    bdOpacity: cur.bdOpacity * (1 - smooth(0.25, 0.9, r)),
  });
}

/**
 * La vitesse de départ d'un retour, en progression par seconde.
 *
 * Un aller interrompu avançait de `v·span` pixels par seconde vers la fiche ; le retour, long de
 * `travelOf(cur, carte)`, part donc à −v·span / longueur : il continue un instant vers la fiche avant
 * de revenir, comme le fait iOS. Lâchée au doigt, la vitesse verticale du doigt (px/s, vers le bas
 * positive) projetée sur le chemin du retour.
 */
export function closeStartVelocity(cur: Box, to: Box, interrupted: { v: number; span: number } | null, fingerVy: number): number {
  if (interrupted) {
    const back = travelOf(cur, to);
    return back > 4 ? (-interrupted.v * interrupted.span) / back : 0;
  }
  if (fingerVy === 0) return 0;
  const dx = to.x + to.w / 2 - (cur.x + cur.w / 2);
  const dy = to.y + to.h / 2 - (cur.y + cur.h / 2);
  const len2 = dx * dx + dy * dy;
  return len2 > 1 ? (fingerVy * dy) / len2 : 0;
}

/** La découpe qui ne laisse voir que `b` d'un calque de `W` × `H` — l'ancien moteur, gardé par le banc. */
export function insetClip(b: Box, W: number, H: number, radius: string): string {
  return `inset(${b.y}px ${W - b.x - b.w}px ${H - b.y - b.h}px ${b.x}px round ${radius})`;
}

/** Le moteur du trajet : la fenêtre transformée (compositeur), ou l'ancienne découpe animée (banc). */
export type MorphEngine = "transform" | "clip";

/**
 * Les images clés du trajet pour chaque calque. Moteur « transform » : la fenêtre, posée sur `base`,
 * est translatée et étirée jusqu'à la boîte du moment ; son contenu est contre-étiré à l'identique,
 * si bien que les images gardent leurs proportions et leur netteté ; les coins, en unités locales de
 * la fenêtre, se recalculent pour rester ronds à l'écran (piste à part : un rayon ne passe pas par le
 * compositeur, et ne doit pas en écarter la transformation). Moteur « clip » : la fenêtre couvre la
 * scène et se découpe, comme avant la sixième passe.
 */
export function morphTracks(poseAt: (q: number) => Pose, samples: Sample[], base: Box, stage: Stage, engine: MorphEngine = "transform") {
  const win: Keyframe[] = [];
  const radius: Keyframe[] = [];
  const inner: Keyframe[] = [];
  const bd: Keyframe[] = [];
  const poster: Keyframe[] = [];
  for (const { offset, q } of samples) {
    const p = poseAt(q);
    const b = p.box;
    if (engine === "transform") {
      const sx = Math.max(1e-3, b.w / Math.max(1, base.w));
      const sy = Math.max(1e-3, b.h / Math.max(1, base.h));
      win.push({ offset, transform: `translate(${(b.x - base.x).toFixed(2)}px, ${(b.y - base.y).toFixed(2)}px) scale(${sx.toFixed(5)}, ${sy.toFixed(5)})` });
      inner.push({ offset, transform: `scale(${(1 / sx).toFixed(5)}, ${(1 / sy).toFixed(5)}) translate(${(-b.x).toFixed(2)}px, ${(-b.y).toFixed(2)}px)` });
      const h = p.corners.map((c) => `${(c / sx).toFixed(2)}px`).join(" ");
      const v = p.corners.map((c) => `${(c / sy).toFixed(2)}px`).join(" ");
      radius.push({ offset, borderRadius: `${h} / ${v}` });
    } else {
      win.push({ offset, clipPath: insetClip(b, stage.W, stage.H, p.corners.map((c) => `${c.toFixed(2)}px`).join(" ")) });
    }
    bd.push({ offset, transform: tfCss(p.bd), opacity: p.bdOpacity });
    poster.push({ offset, transform: tfCss(p.poster), opacity: p.posterOpacity });
  }
  return { win, radius, inner, bd, poster };
}

/** La vitesse du doigt au relâché (px/s, vers le bas positive), sur ses 100 dernières millisecondes. */
export function releaseVelocity(moves: { t: number; y: number }[]): number {
  if (moves.length < 2) return 0;
  const last = moves[moves.length - 1];
  const first = moves.find((m) => last.t - m.t <= 100) ?? moves[0];
  const dt = last.t - first.t;
  return dt > 0 ? ((last.y - first.y) / dt) * 1000 : 0;
}
