/**
 * La passe « son multiplexé » de la page de banc `/lumen-test` (étape 3f de docs/remux-serveur/) : ce qui se juge sans
 * navigateur — la liste maître lue par la page, la piste qu'elle désigne, et le verdict de fin.
 *
 * La question : **le son par défaut multiplexé dans les segments vidéo (levier a de l'étape 3e, `trials.ts`) fait-il
 * démarrer ou repartir Lumen serveur plus vite, et sans rien casser ?** Une liste, un init et un segment de moins à
 * demander avant la première image — mais la spécification d'auteur d'Apple le déconseille (9.5 SHOULD des flux
 * séparés, 9.6 et 9.7 MUST pour le multicanal et les autres langues). La passe « leviers » du 16/11/2026 ne l'avait
 * essayé qu'une fois, sans témoin, sur un lien qui variait de 23 à 100 Mb/s : rien de concluant. Le plan
 * (`MUX_SERIES`, autoSeries.ts) joue donc chaque titre trois fois dans chaque mode, en alternance, mêmes sauts ; ce
 * module en tire un verdict **contre la dispersion des répétitions**, et les contrôles de non-régression.
 *
 * **Le verdict d'une mesure** (première image, `seekedMs`, reprise `advanceMs` — par essai, la médiane de ses sauts) :
 * les trois valeurs de chaque mode, leurs médianes, l'écart (multiplexé − règle). Il n'est déclaré que si **les deux
 * groupes de répétitions ne se chevauchent pas** (le plus lent d'un mode plus rapide que le plus rapide de l'autre —
 * sous l'hypothèse d'aucune différence, cela arrive une fois sur dix à trois contre trois) **et** si l'écart dépasse
 * 50 ms ; sinon « pas de différence au-delà du bruit », avec l'écart et la dispersion (la plus grande étendue des deux
 * modes) pour que le lecteur juge. Pour la reprise, en plus, la comparaison **position par position** : les six essais
 * d'un titre demandent les mêmes six positions, et l'on compte celles où la médiane multiplexée est la plus rapide.
 *
 * **La non-régression** : erreurs, gels, sauts manqués, blocages, images perdues et corrompues par mode ; la piste
 * entendue au départ (`audioTracks` contre le rendu DEFAULT de la liste maître) ; le changement de piste (reprise,
 * blocage, appliqué ou non, segments de la nouvelle piste vus arriver par la page) ; et les pistes annoncées,
 * identiques d'un mode à l'autre. Ce que la page ne sait pas — si le son a vraiment changé, si la voix est en phase
 * avec les lèvres — fait l'objet de deux questions de fin.
 *
 * Rien ici n'importe le reste de la page à l'exécution (autoSeries.ts l'importe : seulement des types dans ce sens).
 */

import type { AudioCheck, TrialResult } from "./autoSeries";

// ── La liste maître ──────────────────────────────────────────────────────────

/** Un rendu audio de la liste maître (`#EXT-X-MEDIA:TYPE=AUDIO`), dans l'ordre du texte. */
export interface MasterMedia {
  group: string;
  language: string;
  name: string;
  isDefault: boolean;
  /** `a3.m3u8` ; null : le rendu est dans les segments de la variante (le son multiplexé, RFC 8216 §4.3.4.2.1). */
  uri: string | null;
}

export interface MasterVariant {
  bandwidth: number;
  average?: number;
  audio?: string;
  uri: string;
}

/** Les attributs d'une balise HLS : `KEY=valeur` ou `KEY="valeur, avec virgules"`. */
function attributesOf(line: string): Record<string, string> {
  const out: Record<string, string> = {};
  const body = line.slice(line.indexOf(":") + 1);
  const re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
  for (let m = re.exec(body); m; m = re.exec(body)) out[m[1]] = m[2].startsWith('"') ? m[2].slice(1, -1) : m[2];
  return out;
}

/** Les rendus audio et les variantes d'une liste maître, dans l'ordre. */
export function parseMaster(text: string): { media: MasterMedia[]; variants: MasterVariant[] } {
  const lines = text.split("\n").map((l) => l.trim());
  const media: MasterMedia[] = [];
  const variants: MasterVariant[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith("#EXT-X-MEDIA:")) {
      const a = attributesOf(line);
      if (a.TYPE !== "AUDIO") continue;
      media.push({ group: a["GROUP-ID"] ?? "", language: (a.LANGUAGE ?? "").toLowerCase(), name: a.NAME ?? "", isDefault: a.DEFAULT === "YES", uri: a.URI ?? null });
    } else if (line.startsWith("#EXT-X-STREAM-INF:")) {
      const a = attributesOf(line);
      const uri = lines.slice(i + 1).find((l) => l && !l.startsWith("#"));
      if (!uri) continue;
      variants.push({ bandwidth: Number(a.BANDWIDTH) || 0, ...(a["AVERAGE-BANDWIDTH"] ? { average: Number(a["AVERAGE-BANDWIDTH"]) } : {}), ...(a.AUDIO ? { audio: a.AUDIO } : {}), uri });
    }
  }
  return { media, variants };
}

/** Ce que la page attend d'une liste maître : les pistes que Safari doit annoncer, celle qu'il doit allumer, le débit. */
export interface ExpectedAudio {
  /** Les rendus du groupe de la variante en tête, dans l'ordre : ce que `audioTracks` doit annoncer. */
  renditions: MasterMedia[];
  /** Le rang du rendu DEFAULT=YES dans ce groupe (-1 : aucun). */
  defaultIndex: number;
  /** AVERAGE-BANDWIDTH de la variante en tête (sinon BANDWIDTH), en Mb/s. */
  streamMbps?: number;
  /** La liste maître est-elle multiplexée (un rendu sans URI, et une variante `vm{N}.m3u8`) ? */
  muxed: boolean;
}

/**
 * Le groupe audio de la variante en tête (celle qu'un lecteur prend d'abord : `masterPlaylist` y place le groupe de la
 * piste choisie, playlists.ts) et son rendu par défaut. Une liste sans variante ni rendu : null.
 */
export function expectedAudio(text: string): ExpectedAudio | null {
  const { media, variants } = parseMaster(text);
  const lead = variants[0];
  if (!lead) return null;
  const renditions = lead.audio ? media.filter((m) => m.group === lead.audio) : [];
  const bps = lead.average ?? lead.bandwidth;
  return {
    renditions,
    defaultIndex: renditions.findIndex((m) => m.isDefault),
    ...(bps > 0 ? { streamMbps: Math.round(bps / 100_000) / 10 } : {}),
    muxed: /^vm\d+\.m3u8$/.test(lead.uri) && renditions.some((m) => m.uri === null),
  };
}

/** `a3.m3u8` → 3 : le numéro Matroska d'un rendu séparé ; null pour un rendu multiplexé ou une URI d'une autre forme. */
export function trackOfUri(uri: string | null): number | null {
  const m = uri ? /^a([1-9]\d{0,3})\.m3u8$/.exec(uri) : null;
  return m ? Number(m[1]) : null;
}

/** Une piste de `video.audioTracks`, réduite à ce que la passe compare. */
export interface TrackLike {
  language: string;
  label: string;
  enabled: boolean;
}

const trackKey = (language: string, label: string) => `${(language || "?").toLowerCase()}:${label || "?"}`;

/**
 * La piste entendue au départ est-elle la bonne ? La piste allumée de `audioTracks` contre le rendu DEFAULT du groupe
 * de la variante en tête — par la langue et l'étiquette (NAME, `trackLabel.ts`, la même pour tous les rendus d'un
 * fichier sauf homonymes). Sans pistes annoncées ni liste lue : pas de verdict (`ok` absent), jamais un faux « faux ».
 */
export function checkAudio(expected: ExpectedAudio | null, tracks: readonly TrackLike[]): AudioCheck {
  const enabled = tracks.find((t) => t.enabled);
  const want = expected && expected.defaultIndex >= 0 ? expected.renditions[expected.defaultIndex] : undefined;
  const out: AudioCheck = {
    ...(want ? { want: trackKey(want.language, want.name) } : {}),
    ...(enabled ? { got: trackKey(enabled.language, enabled.label) } : {}),
    ...(tracks.length ? { tracks: tracks.map((t) => trackKey(t.language, t.label)) } : {}),
  };
  if (out.want && tracks.length) out.ok = out.got === out.want;
  return out;
}

/**
 * La piste vers laquelle changer : la première après la piste allumée (en tournant) dont la langue diffère — un
 * changement qui s'entend ; à défaut, la suivante. -1 : moins de deux pistes.
 */
export function switchTarget(tracks: readonly TrackLike[]): number {
  if (tracks.length < 2) return -1;
  const current = Math.max(0, tracks.findIndex((t) => t.enabled));
  for (let k = 1; k < tracks.length; k++) {
    const i = (current + k) % tracks.length;
    if ((tracks[i].language || "?").toLowerCase() !== (tracks[current].language || "?").toLowerCase()) return i;
  }
  return (current + 1) % tracks.length;
}

// ── Le verdict ───────────────────────────────────────────────────────────────

/** Sous ce débit mesuré avant l'essai, un essai est signalé, quel que soit le titre. */
export const LINK_FLOOR_MBPS = 30;
/** …et sous ce multiple du débit moyen annoncé du titre : le lien, et non le lecteur, a pu décider du temps. */
export const LINK_STREAM_FACTOR = 1.5;
/** En deçà, un écart constant entre les modes n'est pas un gain qui se voit (une image à 24 i/s dure 42 ms). */
export const MIN_EFFECT_MS = 50;

export type MuxMode = "normal" | "multiplexé";
export const modeOfResult = (r: Pick<TrialResult, "mode">): MuxMode => (r.mode?.split("-").includes("mux") ? "multiplexé" : "normal");

/** Une mesure comparée : les valeurs de chaque mode, leurs médianes, l'écart, la dispersion, le verdict. */
export interface MuxMetric {
  normal: number[];
  mux: number[];
  medNormal?: number;
  medMux?: number;
  /** Multiplexé − règle (ms) : négatif, le multiplexé est plus rapide. */
  diffMs?: number;
  /** La plus grande étendue (max − min) des répétitions des deux modes. */
  noiseMs?: number;
  /** Les deux groupes de répétitions ne se chevauchent pas. */
  separated: boolean;
  /** `plus-rapide`, `plus-lent`, `minime` (séparés mais sous 50 ms), `bruit`, `inconnu` (moins de deux essais d'un mode). */
  kind: "plus-rapide" | "plus-lent" | "minime" | "bruit" | "inconnu";
  verdict: string;
  /** La reprise, position par position : celles où la médiane multiplexée est la plus rapide, sur celles mesurées dans les deux modes. */
  faster?: number;
  positions?: number;
}

/** Les contrôles de non-régression d'un mode, sur les essais d'un titre. */
export interface MuxChecks {
  trials: number;
  ok: number;
  errors: number;
  freezes: number;
  missed: number;
  waits: number;
  dropped: number;
  corrupted: number;
  /** Piste au départ : jugée, et la bonne. */
  audioChecked: number;
  audioOk: number;
  /** Changements de piste : faits, avec un ennui (pas de reprise, blocage, erreur, gel), non appliqués. */
  switches: number;
  switchTrouble: number;
  switchNotApplied: number;
  /** Médianes : reprise après le changement (ms) et segments de la nouvelle piste reçus dans la fenêtre. */
  switchMs?: number;
  switchSegs?: number;
}

/** Un essai, tel que le tableau de fin le montre. */
export interface MuxTrialRow {
  rank: number;
  rep?: number;
  mode: MuxMode;
  status: TrialResult["status"];
  linkMbps?: number;
  /** Mesuré sous le seuil de débit du titre. */
  low: boolean;
  firstFrameMs?: number;
  seekedMs?: number;
  resumeMs?: number;
  /** Du geste au premier segment vidéo reçu par la page, au démarrage (Resource Timing). */
  startRecvMs?: number;
  audioOk?: boolean;
}

export interface MuxTitle {
  key: string;
  title: string;
  streamMbps?: number;
  floorMbps: number;
  lowLink: number;
  trials: MuxTrialRow[];
  firstFrame: MuxMetric;
  seeked: MuxMetric;
  resume: MuxMetric;
  checks: Record<MuxMode, MuxChecks>;
  /** Les pistes annoncées par `audioTracks` sont-elles les mêmes dans tous les essais du titre ? */
  tracksSame?: boolean;
  /** Ce qui s'est dégradé en multiplexé (vide : rien de vu). */
  regressions: string[];
}

export interface MuxAnalysis {
  titles: MuxTitle[];
  /** Une phrase par mesure, sur tous les titres : combien penchent de chaque côté. */
  overall: { firstFrame: string; resume: string; regressions: string };
}

function medianOf(values: readonly number[]): number | undefined {
  const sorted = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!sorted.length) return undefined;
  const mid = Math.floor(sorted.length / 2);
  return Math.round(sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2);
}

const range = (values: readonly number[]) => (values.length ? Math.max(...values) - Math.min(...values) : 0);
const nums = (values: readonly (number | undefined)[]) => values.filter((v): v is number => typeof v === "number" && Number.isFinite(v));

/** Le verdict d'une mesure, contre la dispersion des répétitions (voir l'en-tête). */
export function compareMetric(normal: readonly number[], mux: readonly number[]): MuxMetric {
  const out: MuxMetric = { normal: [...normal], mux: [...mux], separated: false, kind: "inconnu", verdict: "pas assez d'essais pour juger" };
  if (normal.length < 2 || mux.length < 2) return out;
  const medNormal = medianOf(normal)!;
  const medMux = medianOf(mux)!;
  const diff = medMux - medNormal;
  const noise = Math.max(range(normal), range(mux));
  const separated = Math.max(...mux) < Math.min(...normal) || Math.min(...mux) > Math.max(...normal);
  Object.assign(out, { medNormal, medMux, diffMs: diff, noiseMs: noise, separated });
  if (separated && Math.abs(diff) >= MIN_EFFECT_MS) {
    out.kind = diff < 0 ? "plus-rapide" : "plus-lent";
    out.verdict = `multiplexé plus ${diff < 0 ? "rapide" : "lent"} de ${Math.abs(diff)} ms (répétitions séparées, dispersion ${noise} ms)`;
  } else if (separated) {
    out.kind = "minime";
    out.verdict = `écart constant mais minime (${diff > 0 ? "+" : ""}${diff} ms, sous ${MIN_EFFECT_MS} ms)`;
  } else {
    out.kind = "bruit";
    out.verdict = `pas de différence au-delà du bruit (écart ${diff > 0 ? "+" : ""}${diff} ms, dispersion ${noise} ms)`;
  }
  return out;
}

/** La reprise position par position : la médiane de chaque mode à chaque rang de saut (les mêmes positions partout). */
function positionsFaster(normal: readonly TrialResult[], mux: readonly TrialResult[]): { faster: number; positions: number } {
  const count = Math.max(0, ...[...normal, ...mux].map((r) => r.advances?.length ?? 0));
  let faster = 0;
  let positions = 0;
  for (let i = 0; i < count; i++) {
    const a = medianOf(nums(normal.map((r) => r.advances?.[i] ?? undefined)));
    const b = medianOf(nums(mux.map((r) => r.advances?.[i] ?? undefined)));
    if (a === undefined || b === undefined) continue;
    positions += 1;
    if (b < a) faster += 1;
  }
  return { faster, positions };
}

function checksOf(results: readonly TrialResult[]): MuxChecks {
  const sum = (pick: (r: TrialResult) => number | undefined) => results.reduce((s, r) => s + (pick(r) ?? 0), 0);
  const switches = results.filter((r) => r.audioSwitch);
  const switchMs = medianOf(nums(switches.map((r) => r.audioSwitch!.ms)));
  const switchSegs = medianOf(nums(switches.map((r) => r.audioSwitch!.segs)));
  return {
    trials: results.length,
    ok: results.filter((r) => r.status === "ok").length,
    errors: sum((r) => r.errors),
    freezes: sum((r) => r.freezes),
    missed: sum((r) => r.missed),
    waits: sum((r) => r.waits),
    dropped: sum((r) => r.dropped),
    corrupted: sum((r) => r.corrupted),
    audioChecked: results.filter((r) => r.audioCheck?.ok !== undefined).length,
    audioOk: results.filter((r) => r.audioCheck?.ok === true).length,
    switches: switches.length,
    switchTrouble: switches.filter((r) => {
      const s = r.audioSwitch!;
      return s.ms === undefined || s.waited || s.errors > 0 || s.freezes > 0;
    }).length,
    switchNotApplied: switches.filter((r) => r.audioSwitch!.applied === false).length,
    ...(switchMs !== undefined ? { switchMs } : {}),
    ...(switchSegs !== undefined ? { switchSegs } : {}),
  };
}

/** Ce que le multiplexé a fait de pire que la règle sur un titre, en phrases courtes. */
function regressionsOf(n: MuxChecks, m: MuxChecks, tracksSame: boolean | undefined): string[] {
  const out: string[] = [];
  const worse = (label: string, a: number, b: number) => {
    if (b > a) out.push(`${label} : ${b} en multiplexé, ${a} en normal`);
  };
  worse("essais sans succès", n.trials - n.ok, m.trials - m.ok);
  worse("erreurs", n.errors, m.errors);
  worse("gels", n.freezes, m.freezes);
  worse("sauts manqués", n.missed, m.missed);
  worse("images corrompues", n.corrupted, m.corrupted);
  // Les blocages et images perdues varient d'un essai à l'autre : signalés au-delà du double et d'un écart de 2.
  if (m.waits > Math.max(2 * n.waits, n.waits + 2)) out.push(`blocages : ${m.waits} en multiplexé, ${n.waits} en normal`);
  if (m.dropped > Math.max(2 * n.dropped, n.dropped + 10)) out.push(`images perdues : ${m.dropped} en multiplexé, ${n.dropped} en normal`);
  if (m.audioChecked > m.audioOk) out.push(`piste au départ fausse : ${m.audioChecked - m.audioOk}/${m.audioChecked} essais multiplexés`);
  if (m.switchNotApplied) out.push(`changement de piste non appliqué : ${m.switchNotApplied}/${m.switches}`);
  if (m.switches && m.switchTrouble / m.switches > (n.switches ? n.switchTrouble / n.switches : 0))
    out.push(`changement de piste avec un ennui : ${m.switchTrouble}/${m.switches} en multiplexé, ${n.switchTrouble}/${n.switches} en normal`);
  if (m.switches && m.switchSegs === 0) out.push("aucun segment de la nouvelle piste reçu après le changement");
  if (tracksSame === false) out.push("pistes annoncées différentes d'un essai à l'autre");
  return out;
}

/**
 * L'analyse de la passe, par titre (dans l'ordre du premier essai de chacun) puis sur l'ensemble : ce que montrent
 * l'écran de fin et la ligne récapitulative (`summaryBody`, `mux`). Les essais sans `rep` (une autre passe) n'y sont pas.
 */
export function analyzeMux(results: readonly TrialResult[]): MuxAnalysis {
  const byKey = new Map<string, TrialResult[]>();
  for (const r of results) {
    if (!r.rep || r.verdicts) continue;
    byKey.set(r.key, [...(byKey.get(r.key) ?? []), r]);
  }
  const titles: MuxTitle[] = [];
  for (const [key, list] of byKey) {
    const normal = list.filter((r) => modeOfResult(r) === "normal");
    const mux = list.filter((r) => modeOfResult(r) === "multiplexé");
    const streamMbps = list.find((r) => r.streamMbps !== undefined)?.streamMbps;
    const floorMbps = Math.max(LINK_FLOOR_MBPS, streamMbps !== undefined ? Math.round(streamMbps * LINK_STREAM_FACTOR) : 0);
    const trials: MuxTrialRow[] = list.map((r) => ({
      rank: r.rank,
      ...(r.rep ? { rep: r.rep } : {}),
      mode: modeOfResult(r),
      status: r.status,
      ...(r.linkMbps !== undefined ? { linkMbps: r.linkMbps } : {}),
      low: r.linkMbps !== undefined && r.linkMbps < floorMbps,
      ...(r.firstFrameMs !== undefined ? { firstFrameMs: r.firstFrameMs } : {}),
      ...(r.seekedMedianMs !== undefined ? { seekedMs: r.seekedMedianMs } : {}),
      ...(r.seekMedianMs !== undefined ? { resumeMs: r.seekMedianMs } : {}),
      ...(r.chrono?.startVideoRecvMs !== undefined ? { startRecvMs: r.chrono.startVideoRecvMs } : {}),
      ...(r.audioCheck?.ok !== undefined ? { audioOk: r.audioCheck.ok } : {}),
    }));
    const lowLink = trials.filter((t) => t.low).length;
    const firstFrame = compareMetric(nums(normal.map((r) => r.firstFrameMs)), nums(mux.map((r) => r.firstFrameMs)));
    const seeked = compareMetric(nums(normal.map((r) => r.seekedMedianMs)), nums(mux.map((r) => r.seekedMedianMs)));
    const resume = compareMetric(nums(normal.map((r) => r.seekMedianMs)), nums(mux.map((r) => r.seekMedianMs)));
    const pos = positionsFaster(normal, mux);
    if (pos.positions) {
      resume.faster = pos.faster;
      resume.positions = pos.positions;
      resume.verdict += ` · multiplexé plus rapide sur ${pos.faster}/${pos.positions} positions`;
    }
    if (lowLink) for (const m of [firstFrame, seeked, resume]) if (m.kind !== "inconnu") m.verdict += ` · ${lowLink} essai${lowLink > 1 ? "s" : ""} sous ${floorMbps} Mb/s`;
    const lists = list.map((r) => r.audioCheck?.tracks?.join("|")).filter((v): v is string => !!v);
    const tracksSame = lists.length >= 2 ? new Set(lists).size === 1 : undefined;
    const checks = { normal: checksOf(normal), multiplexé: checksOf(mux) };
    titles.push({
      key,
      title: list[0].title,
      ...(streamMbps !== undefined ? { streamMbps } : {}),
      floorMbps,
      lowLink,
      trials,
      firstFrame,
      seeked,
      resume,
      checks,
      ...(tracksSame !== undefined ? { tracksSame } : {}),
      regressions: regressionsOf(checks.normal, checks.multiplexé, tracksSame),
    });
  }
  const tally = (pick: (t: MuxTitle) => MuxMetric) => {
    const count = (kind: MuxMetric["kind"]) => titles.filter((t) => pick(t).kind === kind).length;
    const parts = [
      count("plus-rapide") ? `plus rapide sur ${count("plus-rapide")}` : null,
      count("plus-lent") ? `plus lent sur ${count("plus-lent")}` : null,
      count("minime") + count("bruit") ? `sans différence nette sur ${count("minime") + count("bruit")}` : null,
      count("inconnu") ? `non jugé sur ${count("inconnu")}` : null,
    ].filter(Boolean);
    return titles.length ? `multiplexé ${parts.join(", ")} (sur ${titles.length} titre${titles.length > 1 ? "s" : ""})` : "aucun titre mesuré";
  };
  const degraded = titles.filter((t) => t.regressions.length).map((t) => t.title);
  return {
    titles,
    overall: {
      firstFrame: tally((t) => t.firstFrame),
      resume: tally((t) => t.resume),
      regressions: degraded.length ? `dégradation vue sur ${degraded.join(", ")}` : "aucune dégradation vue en multiplexé",
    },
  };
}
