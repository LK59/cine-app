// Ce qui retient l'approvisionnement du lecteur : le réseau, le calcul, ou le décodeur.
//
// 28/09/2026 : le S23 de Lucas bloquait cinquante fois par épisode sur Ted Lasso (4K Dolby Vision,
// 27,5 Mb/s), quand son Mac, derrière la même box, le même soir, sur les mêmes épisodes, n'en
// avait aucune. Le journal ne permettait pas de trancher. Le proxy inverse disait que la connexion
// livrait le débit du fichier en moyenne horaire ; la ligne `stall` disait un tampon presque vide,
// un dernier envoi vieux de 7 s, et une horloge figée *avec* 2,6 s d'avance juste avant. Soit le
// Wi-Fi du téléphone, soit le travail que seul Android paie (l'E-AC3 décodé puis ré-encodé en AAC,
// que Safari laisse passer tel quel), soit son décodeur. Aucune de ces trois lectures n'avait de
// chiffre pour elle.
//
// Ce module en tient les chiffres. Chaque étage de la chaîne note ses intervalles — une requête du
// premier octet envoyé au dernier reçu, une lecture qui attend ses octets, un segment construit,
// le son ré-encodé, un envoi au tampon — et le fil principal ses tâches longues. Les lignes
// `stall` (les 30 s d'avant) et `stop` (la séance) les lisent, et chaque attente de la séance est
// classée à sa fin selon ce qui la précédait.
//
// Global, comme `trace` : un lecteur à la fois, et la séance le délimite (`diagBegin`/`diagEnd`,
// par son identifiant — le mini-lecteur qui cède la place à un autre titre démonte l'ancien hôte
// après le montage du nouveau). Tout est horodaté par `performance.now()`.
//
// Mesure seulement, sur le chemin même qui va mal : rien ici ne lève, jamais.

import { MIN_WAIT_MS } from "@/lib/playerSessionTally";
import { trace } from "./trace";

/** Les intervalles notés. */
export type DiagKind =
  /** Une requête réseau, de l'envoi au dernier octet. */
  | "net"
  /** Une lecture d'octets qui a attendu (réseau ou stockage de l'appareil) — le remultiplexeur à sec. */
  | "read"
  /** La construction d'un segment, lectures comprises (`Remuxer.nextSegment`). */
  | "segment"
  /** Le son ré-encodé d'un segment, décodage et encodage (`AudioTranscoder.framesUpTo`). */
  | "audio"
  /** Un envoi au tampon, jusqu'à `updateend`. */
  | "append"
  /** Une tâche longue du fil principal, telle que le navigateur la rapporte (Chromium). */
  | "longtask";

interface Interval {
  kind: DiagKind;
  from: number;
  to: number;
  bytes: number;
  /** Requêtes seulement : le délai jusqu'aux en-têtes. */
  firstByteMs?: number;
}

/** Ce qu'on garde d'intervalles : deux minutes, assez pour une fenêtre de 30 s et une attente longue. */
const KEPT_MS = 120_000;
/** La fenêtre d'une ligne `stall`. */
export const STALL_WINDOW_MS = 30_000;
/**
 * Ce qui précède une attente et l'explique : le tampon s'est vidé *avant* qu'elle commence. Dix
 * secondes, soit à peu près ce qu'un segment et sa lecture en avance couvrent à ces débits.
 */
const BEFORE_WAIT_MS = 10_000;
/** Le pas de l'échantillonneur : retard de la boucle d'événements et images affichées. */
const SAMPLE_EVERY_MS = 500;
/** Un retard au-delà vient d'une page en arrière-plan (minuteurs bridés), pas d'un fil occupé. */
const LAG_BACKGROUND_MS = 10_000;
/** Avance au début d'une attente au-delà de laquelle le média était là : le décodeur, pas l'approvisionnement. */
const DECODER_LEAD_SECONDS = 1;

interface Sample {
  at: number;
  lagMs: number;
  frames: number | null;
  dropped: number | null;
}

interface WaitCounts {
  réseau: number;
  calcul: number;
  décodeur: number;
  autre: number;
}

interface Session {
  id: string;
  startedAt: number;
  intervals: Interval[];
  samples: Sample[];
  /** Totaux de la séance. `busy` : l'union des intervalles de ce type, calculée à l'arrivée. */
  totals: Record<DiagKind, { count: number; ms: number; bytes: number; coveredUntil: number }>;
  failedRequests: number;
  firstBytes: number[];
  slowestMs: number;
  serverMaxMs: number | null;
  lagMaxMs: number;
  /** Le débit moyen du fichier, en bits par seconde — ce que la chaîne doit tenir. */
  needBps: number | null;
  video: HTMLVideoElement | null;
  waitStartedAt: number | null;
  waitLead: number | null;
  waits: WaitCounts;
  waitMs: WaitCounts;
  connectionTypes: Set<string>;
  connectionChanges: number;
  downlinkMin: number | null;
  battery: { level: number; charging: boolean } | null;
  cleanup: (() => void)[];
}

let current: Session | null = null;

function now(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

function emptyTotals(): Session["totals"] {
  const zero = () => ({ count: 0, ms: 0, bytes: 0, coveredUntil: 0 });
  return { net: zero(), read: zero(), segment: zero(), audio: zero(), append: zero(), longtask: zero() };
}

/** `navigator.connection`, non typé par lib.dom — Chromium seulement ; `type` sur Android seulement. */
interface ConnectionLike extends EventTarget {
  type?: string;
  effectiveType?: string;
  downlink?: number;
  rtt?: number;
  saveData?: boolean;
}

function connection(): ConnectionLike | null {
  try {
    const c = (typeof navigator !== "undefined" ? (navigator as Navigator & { connection?: ConnectionLike }).connection : undefined) ?? null;
    return c && typeof c === "object" ? c : null;
  } catch {
    return null;
  }
}

function noteConnection(session: Session): void {
  const c = connection();
  if (!c) return;
  if (typeof c.type === "string") session.connectionTypes.add(c.type);
  // `downlink` sature à 10 Mb/s (voir networkBitrate.ts) : son minimum reste une vraie mesure.
  if (typeof c.downlink === "number" && Number.isFinite(c.downlink)) {
    session.downlinkMin = session.downlinkMin === null ? c.downlink : Math.min(session.downlinkMin, c.downlink);
  }
}

/**
 * Une séance commence : tout repart de zéro, et l'échantillonneur démarre. Le même identifiant une
 * seconde fois ne fait rien — un hôte remonté pour la même séance garde ce qu'il a mesuré.
 */
export function diagBegin(id: string): void {
  try {
    if (current?.id === id) return;
    if (current) stop(current);
    const session: Session = {
      id,
      startedAt: now(),
      intervals: [],
      samples: [],
      totals: emptyTotals(),
      failedRequests: 0,
      firstBytes: [],
      slowestMs: 0,
      serverMaxMs: null,
      lagMaxMs: 0,
      needBps: null,
      video: null,
      waitStartedAt: null,
      waitLead: null,
      waits: { réseau: 0, calcul: 0, décodeur: 0, autre: 0 },
      waitMs: { réseau: 0, calcul: 0, décodeur: 0, autre: 0 },
      connectionTypes: new Set(),
      connectionChanges: 0,
      downlinkMin: null,
      battery: null,
      cleanup: [],
    };
    current = session;
    start(session);
  } catch {
    /* une mesure n'est pas une lecture */
  }
}

/** La séance se termine : minuteur et observateurs arrêtés. Seulement si c'est bien elle. */
export function diagEnd(id: string): void {
  try {
    if (!current || current.id !== id) return;
    stop(current);
    current = null;
  } catch {
    /* une mesure n'est pas une lecture */
  }
}

function start(session: Session): void {
  noteConnection(session);
  const c = connection();
  if (c && typeof c.addEventListener === "function") {
    const onChange = () => {
      session.connectionChanges += 1;
      noteConnection(session);
    };
    c.addEventListener("change", onChange);
    session.cleanup.push(() => c.removeEventListener("change", onChange));
  }

  // Les tâches longues : Chromium seulement, et c'est lui qu'on instruit. Ailleurs, le retard de
  // la boucle d'événements (ci-dessous) en donne l'ombre.
  try {
    if (typeof PerformanceObserver !== "undefined" && PerformanceObserver.supportedEntryTypes?.includes("longtask")) {
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) record(session, "longtask", entry.startTime, entry.startTime + entry.duration, 0);
      });
      observer.observe({ type: "longtask", buffered: false });
      session.cleanup.push(() => observer.disconnect());
    }
  } catch {
    /* pas d'observateur, pas de tâches longues */
  }

  // La batterie : un appareil en économie d'énergie bride son processeur, et rien d'autre ne le dit.
  try {
    const nav = navigator as Navigator & { getBattery?: () => Promise<{ level: number; charging: boolean }> };
    if (typeof nav.getBattery === "function") {
      nav.getBattery().then(
        (battery) => {
          if (current === session) session.battery = battery;
        },
        () => {}
      );
    }
  } catch {
    /* pas de batterie à lire */
  }

  let expected = now() + SAMPLE_EVERY_MS;
  const timer = setInterval(() => {
    try {
      const at = now();
      const lag = Math.max(0, at - expected);
      expected = at + SAMPLE_EVERY_MS;
      const hidden = typeof document !== "undefined" && document.visibilityState === "hidden";
      // Au premier plan seulement : en arrière-plan, les minuteurs sont bridés exprès.
      const lagMs = hidden || lag > LAG_BACKGROUND_MS ? 0 : Math.round(lag);
      session.lagMaxMs = Math.max(session.lagMaxMs, lagMs);
      let frames: number | null = null;
      let dropped: number | null = null;
      const quality = session.video?.getVideoPlaybackQuality?.();
      if (quality) {
        frames = quality.totalVideoFrames - quality.droppedVideoFrames;
        dropped = quality.droppedVideoFrames;
      }
      session.samples.push({ at, lagMs, frames, dropped });
      prune(session.samples, at);
    } catch {
      /* un échantillon de moins */
    }
  }, SAMPLE_EVERY_MS);
  session.cleanup.push(() => clearInterval(timer));
}

function stop(session: Session): void {
  for (const undo of session.cleanup.splice(0)) {
    try {
      undo();
    } catch {
      /* rien */
    }
  }
}

function prune<T extends { at?: number; to?: number }>(list: T[], at: number): void {
  // Retiré par blocs, pas à chaque ajout : une coupe toutes les quelques centaines d'entrées.
  if (list.length < 400) return;
  const limit = at - KEPT_MS;
  const first = list.findIndex((item) => (item.to ?? item.at ?? 0) >= limit);
  if (first > 0) list.splice(0, first);
}

function record(session: Session, kind: DiagKind, from: number, to: number, bytes: number, firstByteMs?: number): void {
  if (!(to >= from)) return;
  session.intervals.push(firstByteMs === undefined ? { kind, from, to, bytes } : { kind, from, to, bytes, firstByteMs });
  prune(session.intervals, to);
  const total = session.totals[kind];
  total.count += 1;
  total.bytes += bytes;
  // L'union, approchée à l'arrivée : ce qui dépasse la fin de ce qui est déjà couvert. Exacte
  // quand les intervalles arrivent dans l'ordre de leur fin, ce qui est le cas presque partout ;
  // six requêtes en vol ne comptent pas six fois le même temps de lien.
  total.ms += Math.max(0, to - Math.max(from, total.coveredUntil));
  total.coveredUntil = Math.max(total.coveredUntil, to);
}

/** Un intervalle d'un étage de la chaîne. `from` pris par `diagNow()` au début. */
export function diagInterval(kind: DiagKind, from: number, bytes = 0): void {
  try {
    if (current) record(current, kind, from, now(), bytes);
  } catch {
    /* une mesure n'est pas une lecture */
  }
}

/** L'horloge des intervalles — à prendre au début de ce qu'on mesure. */
export function diagNow(): number {
  return now();
}

/** Une requête réseau terminée : ses trois instants, ses octets, et le temps du serveur s'il l'a dit. */
export function diagRequest(sentAt: number, headersAt: number, endAt: number, bytes: number, serverMs: number | null): void {
  try {
    const session = current;
    if (!session) return;
    record(session, "net", sentAt, endAt, bytes, headersAt - sentAt);
    session.firstBytes.push(headersAt - sentAt);
    if (session.firstBytes.length > 2000) session.firstBytes.splice(0, 1000);
    session.slowestMs = Math.max(session.slowestMs, endAt - sentAt);
    if (serverMs !== null) session.serverMaxMs = Math.max(session.serverMaxMs ?? 0, serverMs);
  } catch {
    /* une mesure n'est pas une lecture */
  }
}

/** Une tentative de requête qui a échoué (pas une lecture abandonnée pour un saut). */
export function diagRequestFailed(): void {
  if (current) current.failedRequests += 1;
}

/** Le fichier de la séance : son poids et sa durée, pour le débit qu'il demande. */
export function diagMedia(bytes: number, seconds: number, video: HTMLVideoElement | null): void {
  try {
    if (!current) return;
    if (bytes > 0 && seconds > 0) current.needBps = (bytes * 8) / seconds;
    current.video = video;
  } catch {
    /* une mesure n'est pas une lecture */
  }
}

/** L'union des intervalles d'un type dans [from, to]. */
function busyMs(intervals: Interval[], kind: DiagKind, from: number, to: number): number {
  const spans = intervals
    .filter((i) => i.kind === kind && i.to > from && i.from < to)
    .map((i) => [Math.max(i.from, from), Math.min(i.to, to)] as const)
    .sort((a, b) => a[0] - b[0]);
  let total = 0;
  let end = -Infinity;
  for (const [a, b] of spans) {
    if (b <= end) continue;
    total += b - Math.max(a, end);
    end = b;
  }
  return total;
}

/** Les octets reçus dans [from, to], chaque requête au prorata de ce qui en tombe dedans. */
function bytesIn(intervals: Interval[], from: number, to: number): number {
  let total = 0;
  for (const i of intervals) {
    if (i.kind !== "net" || i.to <= from || i.from >= to) continue;
    const length = i.to - i.from;
    total += length > 0 ? (i.bytes * (Math.min(i.to, to) - Math.max(i.from, from))) / length : i.bytes;
  }
  return total;
}

function mbps(bytes: number, ms: number): number | null {
  return ms > 0 ? Math.round(((bytes * 8) / (ms / 1000) / 1e6) * 10) / 10 : null;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return Math.round(sorted[Math.floor(sorted.length / 2)]);
}

function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return Math.round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]);
}

/** Ce qui a occupé la chaîne dans [from, to] — la matière d'une fenêtre et d'un verdict. */
interface Window {
  spanMs: number;
  bytes: number;
  requests: number;
  netMs: number;
  readMs: number;
  segmentMs: number;
  audioMs: number;
  appendMs: number;
  longTaskMs: number;
  longTasks: number;
}

function windowOf(session: Session, from: number, to: number): Window {
  const { intervals } = session;
  return {
    spanMs: to - from,
    bytes: bytesIn(intervals, from, to),
    requests: intervals.filter((i) => i.kind === "net" && i.to > from && i.to <= to).length,
    netMs: busyMs(intervals, "net", from, to),
    readMs: busyMs(intervals, "read", from, to),
    segmentMs: busyMs(intervals, "segment", from, to),
    audioMs: busyMs(intervals, "audio", from, to),
    appendMs: busyMs(intervals, "append", from, to),
    longTaskMs: busyMs(intervals, "longtask", from, to),
    longTasks: intervals.filter((i) => i.kind === "longtask" && i.to > from && i.from < to).length,
  };
}

/**
 * Ce qui a retenu la chaîne, d'après une fenêtre.
 *
 * Un indice, pas une preuve — les chiffres qui l'ont décidé partent avec lui, et c'est eux qu'on
 * lit. Dans l'ordre :
 *  - **décodeur** : il y avait du média sous la tête (au moins une seconde d'avance) et l'horloge
 *    ne bougeait pas. Rien à approvisionner : c'est l'élément qui n'avance pas.
 *  - **réseau** : la chaîne a passé la moitié de la fenêtre au moins à attendre ses octets.
 *  - **calcul** : la construction des segments hors attente d'octets, le son ré-encodé, les envois
 *    et les tâches longues du fil principal en ont occupé la moitié au moins.
 *  - **autre** : ni l'un ni l'autre — une chaîne à l'arrêt (saut, budget atteint), ou ce qu'on ne
 *    mesure pas.
 */
export type Verdict = "décodeur" | "réseau" | "calcul" | "autre";

function verdictOf(w: Window, lead: number | null): Verdict {
  if (lead !== null && lead >= DECODER_LEAD_SECONDS) return "décodeur";
  if (w.spanMs <= 0) return "autre";
  if (w.readMs / w.spanMs >= 0.5) return "réseau";
  const compute = Math.max(0, w.segmentMs - w.readMs) + w.appendMs + w.longTaskMs;
  if (compute / w.spanMs >= 0.5) return "calcul";
  return "autre";
}

function connectionFacts(session: Session): Record<string, string | number | boolean> {
  const facts: Record<string, string | number | boolean> = {};
  const c = connection();
  if (c) {
    if (typeof c.type === "string") facts.conn = c.type;
    if (typeof c.effectiveType === "string") facts.effectiveType = c.effectiveType;
    if (typeof c.downlink === "number") facts.downlinkMbps = c.downlink;
    if (typeof c.rtt === "number") facts.rttMs = c.rtt;
    if (c.saveData) facts.saveData = true;
  }
  if (session.connectionChanges > 0) facts.connChanges = session.connectionChanges;
  return facts;
}

function samplesIn(session: Session, from: number, to: number): Sample[] {
  return session.samples.filter((s) => s.at > from && s.at <= to);
}

/**
 * Les 30 dernières secondes, pour une ligne `stall` — sous `diag`, que `clean()` aplatit en
 * `diag.*`. `lead` : l'avance au moment de la ligne, pour le verdict.
 */
export function diagStallFacts(lead: number | null, windowMs = STALL_WINDOW_MS): Record<string, string | number | boolean> {
  try {
    const session = current;
    if (!session) return {};
    const to = now();
    const from = Math.max(session.startedAt, to - windowMs);
    const w = windowOf(session, from, to);
    const samples = samplesIn(session, from, to);
    const framed = samples.filter((s) => s.frames !== null);
    const facts: Record<string, string | number | boolean> = {
      verdict: verdictOf(w, lead),
      winMs: Math.round(w.spanMs),
      recvMbps: mbps(w.bytes, w.spanMs) ?? 0,
      linkMbps: mbps(w.bytes, w.netMs) ?? 0,
      linkBusyPct: w.spanMs > 0 ? Math.round((w.netMs / w.spanMs) * 100) : 0,
      req: w.requests,
      readWaitMs: Math.round(w.readMs),
      buildMs: Math.round(w.segmentMs),
      audioMs: Math.round(w.audioMs),
      appendMs: Math.round(w.appendMs),
      longTaskMs: Math.round(w.longTaskMs),
      longTasks: w.longTasks,
      lagMaxMs: samples.reduce((m, s) => Math.max(m, s.lagMs), 0),
    };
    const recent = session.intervals.filter((i) => i.kind === "net" && i.to > from);
    if (recent.length > 0) {
      facts.fbMaxMs = Math.round(Math.max(...recent.map((i) => i.firstByteMs ?? 0)));
      facts.slowestMs = Math.round(Math.max(...recent.map((i) => i.to - i.from)));
    }
    if (session.needBps !== null) facts.needMbps = Math.round((session.needBps / 1e6) * 10) / 10;
    if (framed.length >= 2) {
      const first = framed[0];
      const last = framed[framed.length - 1];
      const seconds = (last.at - first.at) / 1000;
      if (seconds > 0) facts.fps = Math.round(((last.frames! - first.frames!) / seconds) * 10) / 10;
      facts.dropped = last.dropped! - first.dropped!;
    }
    if (session.failedRequests > 0) facts.reqFailed = session.failedRequests;
    return { ...facts, ...connectionFacts(session) };
  } catch {
    return {};
  }
}

/** Une attente commence (`waiting` en pleine lecture). `lead` : l'avance que l'élément voit alors. */
export function diagWaitStarted(lead: number | null): void {
  try {
    if (!current || current.waitStartedAt !== null) return;
    current.waitStartedAt = now();
    current.waitLead = lead;
  } catch {
    /* une mesure n'est pas une lecture */
  }
}

/**
 * L'attente est finie (ou abandonnée par un saut, `counted` faux) : classée d'après les dix
 * secondes qui l'ont précédée et sa propre durée — le tampon s'est vidé avant qu'elle commence.
 * Les attentes trop brèves pour se voir ne sont pas comptées, comme dans `SessionTally`.
 */
export function diagWaitEnded(counted = true): void {
  try {
    const session = current;
    if (!session || session.waitStartedAt === null) return;
    const started = session.waitStartedAt;
    const lead = session.waitLead;
    session.waitStartedAt = null;
    session.waitLead = null;
    const end = now();
    if (!counted || end - started < MIN_WAIT_MS) return;
    const w = windowOf(session, Math.max(session.startedAt, started - BEFORE_WAIT_MS), end);
    const verdict = verdictOf(w, lead);
    session.waits[verdict] += 1;
    session.waitMs[verdict] += end - started;
    // Dans la trace aussi, à partir d'une seconde : le rapport copiable et les `steps` d'un blocage
    // disent alors ce qui a précédé, attente par attente.
    if (end - started >= 1000) {
      trace(
        `attente de ${Math.round(end - started)} ms (${verdict}) — avance ${lead ?? "?"} s ; sur les ${Math.round(w.spanMs / 1000)} s : ` +
          `${mbps(w.bytes, w.spanMs) ?? 0} Mb/s reçus, lien occupé ${w.spanMs > 0 ? Math.round((w.netMs / w.spanMs) * 100) : 0} %, ` +
          `octets attendus ${Math.round(w.readMs)} ms, segments ${Math.round(w.segmentMs)} ms, son ${Math.round(w.audioMs)} ms, ` +
          `envois ${Math.round(w.appendMs)} ms, tâches longues ${Math.round(w.longTaskMs)} ms`
      );
    }
  } catch {
    /* une mesure n'est pas une lecture */
  }
}

/** Le bilan de la séance, pour la ligne `stop` — sous `diag`. */
export function diagSessionFacts(): Record<string, string | number | boolean> {
  try {
    const session = current;
    if (!session) return {};
    const elapsed = now() - session.startedAt;
    const t = session.totals;
    const facts: Record<string, string | number | boolean> = {
      netMB: Math.round((t.net.bytes / 1e6) * 10) / 10,
      recvMbps: mbps(t.net.bytes, elapsed) ?? 0,
      linkMbps: mbps(t.net.bytes, t.net.ms) ?? 0,
      linkBusyPct: elapsed > 0 ? Math.round((t.net.ms / elapsed) * 100) : 0,
      req: t.net.count,
      readWaitS: Math.round(t.read.ms / 100) / 10,
      buildS: Math.round(t.segment.ms / 100) / 10,
      audioS: Math.round(t.audio.ms / 100) / 10,
      appendS: Math.round(t.append.ms / 100) / 10,
      longTaskS: Math.round(t.longtask.ms / 100) / 10,
      longTasks: t.longtask.count,
      lagMaxMs: session.lagMaxMs,
      slowestMs: Math.round(session.slowestMs),
    };
    const fbMed = median(session.firstBytes);
    const fbP90 = percentile(session.firstBytes, 0.9);
    if (fbMed !== null) facts.fbMedMs = fbMed;
    if (fbP90 !== null) facts.fbP90Ms = fbP90;
    if (session.serverMaxMs !== null) facts.serverMaxMs = session.serverMaxMs;
    if (session.failedRequests > 0) facts.reqFailed = session.failedRequests;
    if (session.needBps !== null) facts.needMbps = Math.round((session.needBps / 1e6) * 10) / 10;
    for (const verdict of ["réseau", "calcul", "décodeur", "autre"] as const) {
      if (session.waits[verdict] === 0) continue;
      const key = verdict === "réseau" ? "Net" : verdict === "calcul" ? "Cpu" : verdict === "décodeur" ? "Decoder" : "Other";
      facts[`waits${key}`] = session.waits[verdict];
      facts[`waits${key}Ms`] = Math.round(session.waitMs[verdict]);
    }
    if (session.connectionTypes.size > 0) facts.connSeen = [...session.connectionTypes].join(",");
    if (session.downlinkMin !== null) facts.downlinkMinMbps = session.downlinkMin;
    if (session.battery) {
      facts.battery = Math.round(session.battery.level * 100);
      facts.charging = session.battery.charging;
    }
    try {
      if (typeof navigator !== "undefined") {
        if (typeof navigator.hardwareConcurrency === "number") facts.cores = navigator.hardwareConcurrency;
        const memory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
        if (typeof memory === "number") facts.memGB = memory;
      }
    } catch {
      /* rien */
    }
    return { ...facts, ...connectionFacts(session) };
  } catch {
    return {};
  }
}
