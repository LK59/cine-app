/**
 * La chronologie d'un démarrage et d'un saut, pour la page de banc `/lumen-test` (étape 3e de docs/remux-serveur/,
 * DECISIONS §160).
 *
 * La question qu'elle tranche : **entre l'image affichée après un saut (`seeked`) et la reprise de la lecture, il se
 * passe ~550 ms de plus chez Lumen serveur que chez le lecteur actuel, et au démarrage jusqu'à 0,9 s — est-ce Safari
 * qui attend une réserve, le réseau, ou le serveur ?** Jusqu'ici, la page ne voyait que les évènements de `<video>`,
 * et le serveur que ses envois (la trace de l'étape 3c), chacun sur sa propre horloge : les recoller supposait que
 * la première requête arrivait à l'instant du geste.
 *
 * Trois choses, réunies ici sans navigateur pour s'éprouver en Node (`lumen-test-chrono.test.ts`) :
 * - **les horloges** : quelques échanges avec la route `chrono` au début de l'essai ; le serveur rend l'arrivée et le
 *   départ de sa réponse (`t1`, `t2`), la page note l'envoi et la réception (`t0`, `t3`), et l'on garde le décalage de
 *   l'échange au plus court aller-retour (`clockSample`, `bestClock` — la règle de NTP) ;
 * - **les évènements de la page**, avec ce que `video.buffered` dit d'avance devant la position (`aheadOf`) : en HLS
 *   natif, c'est ce qu'AVFoundation a reçu et analysé ; c'est aussi la seule mesure de ce que l'iPhone a *reçu*, le
 *   serveur ne sachant que ce qu'il a *remis* ;
 * - **la cascade** (`buildCascade`) : pour un démarrage ou un saut, chaque requête du serveur ramenée sur l'horloge
 *   de la page (quand Safari demande quoi, quand c'est prêt, quand les octets partent), chaque évènement, et l'avance
 *   en secondes à `seeked`, à `playing` et à la reprise.
 *
 * Ce qu'elle ne voit pas, et qui est dit tel quel dans les lignes : l'arrivée réelle des octets sur l'iPhone
 * (le serveur remet un segment de 3 Mo en 2 ms à des tampons de plusieurs Mo — noyau, relais inverse) ; ce que
 * Safari demande sans le dire (la page ne voit pas ses requêtes : `performance.getEntriesByType("resource")` est
 * relevé pour le constater, `rtLumen`) ; et le décodage lui-même.
 */

/** Un échange d'horloge : décalage (horloge du serveur − horloge de la page) et aller-retour, en ms. */
export interface ClockSample {
  offsetMs: number;
  rttMs: number;
}

export interface ClockSync extends ClockSample {
  samples: number;
}

/**
 * Le décalage et l'aller-retour d'un échange, à la manière de NTP : `t0` l'envoi par la page, `t1` l'arrivée au
 * serveur, `t2` le départ de sa réponse, `t3` la réception par la page — toutes en ms depuis l'époque, chacune sur
 * son horloge. Le temps passé dans le serveur (`t2 − t1`, le contrôle d'accès) ne compte pas dans l'aller-retour.
 */
export function clockSample(t0: number, t1: number, t2: number, t3: number): ClockSample {
  return { offsetMs: (t1 - t0 + (t2 - t3)) / 2, rttMs: Math.max(0, t3 - t0 - (t2 - t1)) };
}

/** L'échange au plus court aller-retour : son erreur est bornée par la moitié de cet aller-retour. */
export function bestClock(samples: readonly ClockSample[]): ClockSync | null {
  if (!samples.length) return null;
  const best = samples.reduce((a, b) => (b.rttMs < a.rttMs ? b : a));
  return { offsetMs: Math.round(best.offsetMs * 10) / 10, rttMs: Math.round(best.rttMs * 10) / 10, samples: samples.length };
}

/** Un instant du serveur (ms depuis l'époque, son horloge) sur l'horloge `performance.now()` de la page. */
export function toPageTime(serverMs: number, clock: ClockSync, timeOrigin: number): number {
  return serverMs - clock.offsetMs - timeOrigin;
}

type RangesLike = { length: number; start(i: number): number; end(i: number): number };

/**
 * L'avance (s) devant la position : la fin de la plage de `buffered` qui contient `t`, moins `t` ; à 0,25 s près
 * (une plage qui commence juste après la position, le temps d'un saut). Null : aucune plage là.
 */
export function aheadOf(buffered: RangesLike | null | undefined, t: number): number | null {
  if (!buffered) return null;
  for (let i = 0; i < buffered.length; i++) {
    if (buffered.start(i) <= t + 0.25 && buffered.end(i) >= t) return Math.round((buffered.end(i) - t) * 10) / 10;
  }
  return null;
}

/** Un évènement de la vidéo : instant (`performance.now()`), nom, `readyState`, position, avance. */
export interface PageEvent {
  t: number;
  e: string;
  rs: number;
  ct: number;
  ahead: number | null;
}

/** Une requête vue par le serveur (`ChronoEntry` de `playbackStats.ts`, rendue par `chrono?records=1`). */
export interface ServerEntry {
  name: string;
  at: number;
  ready?: number;
  first?: number;
  last?: number;
  bytes?: number;
  build?: number;
  wait?: number;
  reused?: boolean;
  aborted?: boolean;
  status?: number;
}

/** Ce que Resource Timing dit d'une requête de la page (le lecteur actuel tire lui-même ses octets). */
export interface ResourceLike {
  name: string;
  startTime: number;
  responseStart: number;
  responseEnd: number;
  encodedBodySize?: number;
}

/** Les instants d'un démarrage ou d'un saut, sur l'horloge de la page. */
export interface CascadeMoments {
  kind: "départ" | "saut";
  /** La position visée (s). */
  to: number;
  /** Le geste : l'appui sur Lire, ou `currentTime = to`. */
  startedAt: number;
  /** Le début de la fenêtre, s'il précède le geste : la source posée d'avance (`early: "élément"`). Instants négatifs alors. */
  from?: number;
  seekedAt?: number;
  playingAt?: number;
  /** La première image présentée (départ). */
  frameAt?: number;
  /** La reprise : le temps a avancé de 0,3 s depuis l'atterrissage (saut). */
  advanceAt?: number;
  /** La fin de la fenêtre : la reprise (ou l'image) plus de quoi voir ce que Safari demande ensuite. */
  endAt: number;
}

/**
 * Une cascade, telle que la ligne la porte : les instants en ms depuis le geste, les avances en secondes, et deux
 * listes de lignes courtes.
 * - `req` : `+105 v/12 r23 f25 l140 k3200` — arrivée de la requête au serveur (ramenée sur l'horloge de la page),
 *   prête (`r`), premier et dernier morceau remis (`f`, `l`), relatifs à l'arrivée, poids en Ko ; `p` préparé ou
 *   partagé, `x` coupé, `s410` un statut. Lecteur actuel : `+105 stream l140 k3200` (Resource Timing : début,
 *   fin, poids) ;
 * - `ev` : `+612 seeked rs2 a3.2` — l'évènement, le `readyState`, l'avance (s) ; `a-` : aucune plage à la position.
 */
export interface Cascade {
  k: "départ" | "saut";
  to: number;
  /** Première requête de la fenêtre arrivée au serveur, et premier segment (`.m4s`). */
  firstReqMs?: number;
  firstSegMs?: number;
  /** Le premier segment vidéo : prêt sur le serveur, et remis en entier (ms depuis le geste). */
  firstVideoReadyMs?: number;
  firstVideoSentMs?: number;
  seekedMs?: number;
  playingMs?: number;
  frameMs?: number;
  advanceMs?: number;
  aheadSeekedS?: number;
  aheadPlayingS?: number;
  aheadAdvanceS?: number;
  /** Ce que le serveur avait fini de remettre avant `seeked` et avant la reprise (Mo) : un majorant de ce qui était reçu. */
  sentSeekedMB?: number;
  sentAdvanceMB?: number;
  /** Segments vidéo demandés avant `seeked` et avant la reprise. */
  videoSeeked?: number;
  videoAdvance?: number;
  /** La plus longue préparation d'une réponse dans la fenêtre (file, disque, construction). */
  readyMaxMs?: number;
  /** Octets remis divisés par la durée des envois de la fenêtre, vus du serveur (Mb/s) : majoré par les tampons. */
  srvMbps?: number;
  req: string[];
  ev: string[];
}

/** Au plus, dans une cascade : de quoi voir une rafale de saut entière sans faire une ligne de journal démesurée. */
export const CASCADE_REQUESTS = 48;
export const CASCADE_EVENTS = 60;

const r0 = (v: number) => Math.round(v);
/** Un instant signé depuis le geste : `+105`, ou `-4900` pour ce qui a précédé l'appui (source posée d'avance). */
const signed = (v: number) => (r0(v) >= 0 ? `+${r0(v)}` : `${r0(v)}`);
const mb = (bytes: number) => Math.round(bytes / 10_000) / 100;

/** L'avance relevée au dernier évènement à l'instant `at` ou avant. */
function aheadAt(events: readonly PageEvent[], at: number | undefined): number | undefined {
  if (at === undefined) return undefined;
  let found: PageEvent | undefined;
  for (const e of events) if (e.t <= at + 1) found = e;
  return found?.ahead ?? undefined;
}

/**
 * La cascade d'un démarrage ou d'un saut : les requêtes du serveur arrivées dans la fenêtre (le geste, 50 ms de
 * marge pour l'erreur d'horloge, jusqu'à `endAt`), ramenées sur l'horloge de la page, ou — sans horloge — les
 * requêtes que la page a faites elle-même (Resource Timing, lecteur actuel), et les évènements de la vidéo.
 */
export function buildCascade(
  m: CascadeMoments,
  events: readonly PageEvent[],
  input: { entries?: readonly ServerEntry[]; clock?: ClockSync | null; timeOrigin?: number; resources?: readonly ResourceLike[] }
): Cascade {
  const since = (t: number | undefined) => (t === undefined ? undefined : r0(t - m.startedAt));
  const out: Cascade = {
    k: m.kind,
    to: Math.round(m.to * 10) / 10,
    seekedMs: since(m.seekedAt),
    playingMs: since(m.playingAt),
    frameMs: since(m.frameAt),
    advanceMs: since(m.advanceAt),
    aheadSeekedS: aheadAt(events, m.seekedAt),
    aheadPlayingS: aheadAt(events, m.playingAt),
    aheadAdvanceS: aheadAt(events, m.advanceAt ?? m.frameAt),
    req: [],
    ev: [],
  };
  const from = Math.min(m.from ?? m.startedAt, m.startedAt) - 50;

  if (input.entries && input.clock && input.timeOrigin !== undefined) {
    const clock = input.clock;
    const origin = input.timeOrigin;
    const mine = input.entries
      .map((e) => ({ e, t: toPageTime(e.at, clock, origin) }))
      .filter(({ t }) => t >= from && t <= m.endAt)
      .sort((a, b) => a.t - b.t);
    let sentSeeked = 0;
    let sentAdvance = 0;
    let videoSeeked = 0;
    let videoAdvance = 0;
    let readyMax = 0;
    let firstSend: number | undefined;
    let lastSend: number | undefined;
    let sentBytes = 0;
    for (const { e, t } of mine) {
      const isSegment = e.name.endsWith(".m4s");
      const isVideo = /^v(m\d+)?\//.test(e.name);
      out.firstReqMs ??= r0(t - m.startedAt);
      if (isSegment) out.firstSegMs ??= r0(t - m.startedAt);
      if (e.ready !== undefined) readyMax = Math.max(readyMax, e.ready);
      if (isSegment && isVideo && out.firstVideoReadyMs === undefined && e.ready !== undefined) {
        out.firstVideoReadyMs = r0(t + e.ready - m.startedAt);
        if (e.last !== undefined) out.firstVideoSentMs = r0(t + e.last - m.startedAt);
      }
      const done = e.last !== undefined ? t + e.last : undefined;
      if (isSegment && done !== undefined && !e.aborted) {
        if (m.seekedAt !== undefined && done <= m.seekedAt) sentSeeked += e.bytes ?? 0;
        const resumeAt = m.advanceAt ?? m.frameAt;
        if (resumeAt !== undefined && done <= resumeAt) sentAdvance += e.bytes ?? 0;
        if (e.first !== undefined) firstSend = Math.min(firstSend ?? Infinity, t + e.first);
        lastSend = Math.max(lastSend ?? -Infinity, done);
        sentBytes += e.bytes ?? 0;
      }
      if (isSegment && isVideo) {
        if (m.seekedAt !== undefined && t <= m.seekedAt) videoSeeked += 1;
        const resumeAt = m.advanceAt ?? m.frameAt;
        if (resumeAt !== undefined && t <= resumeAt) videoAdvance += 1;
      }
      if (out.req.length < CASCADE_REQUESTS) {
        const parts = [signed(t - m.startedAt), e.name];
        if (e.ready !== undefined) parts.push(`r${r0(e.ready)}`);
        if (e.first !== undefined) parts.push(`f${r0(e.first)}`);
        if (e.last !== undefined) parts.push(`l${r0(e.last)}`);
        if (e.bytes !== undefined) parts.push(`k${Math.round(e.bytes / 1024)}`);
        if (e.reused) parts.push("p");
        if (e.aborted) parts.push("x");
        if (e.status) parts.push(`s${e.status}`);
        out.req.push(parts.join(" "));
      }
    }
    if (mine.length) {
      out.readyMaxMs = r0(readyMax);
      if (m.seekedAt !== undefined) {
        out.sentSeekedMB = mb(sentSeeked);
        out.videoSeeked = videoSeeked;
      }
      if ((m.advanceAt ?? m.frameAt) !== undefined) {
        out.sentAdvanceMB = mb(sentAdvance);
        out.videoAdvance = videoAdvance;
      }
      if (firstSend !== undefined && lastSend !== undefined && lastSend - firstSend >= 20) out.srvMbps = Math.round((sentBytes * 8) / ((lastSend - firstSend) * 1000));
    }
  } else if (input.resources) {
    const mine = input.resources.filter((r) => r.startTime >= from && r.startTime <= m.endAt).sort((a, b) => a.startTime - b.startTime);
    for (const r of mine) {
      out.firstReqMs ??= r0(r.startTime - m.startedAt);
      if (out.req.length < CASCADE_REQUESTS) {
        const short = r.name.includes("/api/jellyfin/stream") ? "stream" : (r.name.split("?")[0].split("/").pop() ?? "?").slice(0, 24);
        out.req.push(`${signed(r.startTime - m.startedAt)} ${short} f${r0(r.responseStart - r.startTime)} l${r0(r.responseEnd - r.startTime)}${r.encodedBodySize ? ` k${Math.round(r.encodedBodySize / 1024)}` : ""}`);
      }
    }
  }

  for (const e of events) {
    if (e.t < from || e.t > m.endAt) continue;
    if (out.ev.length >= CASCADE_EVENTS) break;
    out.ev.push(`${signed(e.t - m.startedAt)} ${e.e} rs${e.rs} a${e.ahead === null ? "-" : e.ahead}`);
  }
  return out;
}

/** Le débit d'un échantillon (Mb/s), mesuré par la page : de la réponse au dernier octet, Resource Timing d'abord. */
export function probeMbps(bytes: number, ms: number): number | null {
  return ms > 0 && bytes > 0 ? Math.round((bytes * 8) / (ms * 1000)) : null;
}

/** Ce que la série retient des cascades d'un essai : médianes, pour le tableau de fin. */
export interface ChronoSummary {
  /** Avance (s) à la reprise d'un saut, médiane : la réserve que le lecteur a voulue. */
  aheadAdvanceS?: number;
  /** Avance (s) à `seeked`. */
  aheadSeekedS?: number;
  /** Du geste à l'arrivée de la première requête au serveur (ms). */
  firstReqMs?: number;
  /** Du geste au premier segment vidéo prêt sur le serveur (ms). */
  firstVideoReadyMs?: number;
  /** De `seeked` à la reprise (ms). */
  seekedToAdvanceMs?: number;
  /** Segments vidéo demandés avant la reprise. */
  videoAdvance?: number;
  /** La plus longue préparation d'une réponse, sur tout l'essai (ms). */
  readyMaxMs?: number;
}

function medianOf(values: (number | undefined)[]): number | undefined {
  const sorted = values.filter((v): v is number => typeof v === "number" && Number.isFinite(v)).sort((a, b) => a - b);
  if (!sorted.length) return undefined;
  const mid = Math.floor(sorted.length / 2);
  const v = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  return Math.round(v * 10) / 10;
}

export function summarizeCascades(cascades: readonly Cascade[]): ChronoSummary {
  const seeks = cascades.filter((c) => c.k === "saut" && c.advanceMs !== undefined);
  const out: ChronoSummary = {
    aheadAdvanceS: medianOf(seeks.map((c) => c.aheadAdvanceS)),
    aheadSeekedS: medianOf(seeks.map((c) => c.aheadSeekedS)),
    firstReqMs: medianOf(seeks.map((c) => c.firstReqMs)),
    firstVideoReadyMs: medianOf(seeks.map((c) => c.firstVideoReadyMs)),
    seekedToAdvanceMs: medianOf(seeks.map((c) => (c.seekedMs !== undefined && c.advanceMs !== undefined ? c.advanceMs - c.seekedMs : undefined))),
    videoAdvance: medianOf(seeks.map((c) => c.videoAdvance)),
  };
  const ready = cascades.map((c) => c.readyMaxMs).filter((v): v is number => typeof v === "number");
  if (ready.length) out.readyMaxMs = Math.max(...ready);
  for (const key of Object.keys(out) as (keyof ChronoSummary)[]) if (out[key] === undefined) delete out[key];
  return out;
}

// ── Les échanges avec le serveur (navigateur) ────────────────────────────────

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const epochNow = () => performance.timeOrigin + performance.now();

/**
 * Synchronise les horloges pour la lecture `s` (et la marque chronométrée côté serveur) : `count` échanges, le plus
 * court aller-retour gardé. Null si le serveur ne répond pas — l'essai continue, sans chronologie serveur.
 */
export async function syncClock(itemId: string, s: string, count = 5, fetchImpl: FetchLike = fetch): Promise<ClockSync | null> {
  const samples: ClockSample[] = [];
  for (let i = 0; i < count; i++) {
    try {
      const t0 = epochNow();
      const res = await fetchImpl(`/api/lumen/${itemId}/chrono?s=${s}&n=${i}`, { cache: "no-store" });
      const t3 = epochNow();
      if (!res.ok) continue;
      const body = (await res.json()) as { t1?: unknown; t2?: unknown };
      if (typeof body.t1 === "number" && typeof body.t2 === "number") samples.push(clockSample(t0, body.t1, body.t2, t3));
    } catch {
      /* un échange perdu : les autres suffisent */
    }
  }
  return bestClock(samples);
}

/** Un échantillon du débit vers l'appareil : `bytes` aléatoires, mesurés par la page (Resource Timing, sinon la lecture). */
export async function probeLink(itemId: string, s: string, bytes: number, fetchImpl: FetchLike = fetch): Promise<{ mbps: number | null; ms: number; via: "rt" | "lecture" } | null> {
  try {
    const url = `/api/lumen/${itemId}/chrono?s=${s}&bytes=${bytes}&t=${Math.round(performance.now())}`;
    const res = await fetchImpl(url, { cache: "no-store" });
    if (!res.ok) return null;
    const head = performance.now();
    const body = await res.arrayBuffer();
    const end = performance.now();
    const entry = performance.getEntriesByType?.("resource").filter((e) => e.name.endsWith(url) || e.name.includes(url)).at(-1) as PerformanceResourceTiming | undefined;
    if (entry && entry.responseEnd > entry.responseStart && entry.responseStart > 0) {
      const ms = entry.responseEnd - entry.responseStart;
      return { mbps: probeMbps(body.byteLength, ms), ms: r0(ms), via: "rt" };
    }
    return { mbps: probeMbps(body.byteLength, end - head), ms: r0(end - head), via: "lecture" };
  } catch {
    return null;
  }
}

/** Ce que la page a relevé de la chronologie serveur d'une lecture. */
export async function fetchServerChrono(itemId: string, s: string, fetchImpl: FetchLike = fetch): Promise<ServerEntry[] | null> {
  try {
    const res = await fetchImpl(`/api/lumen/${itemId}/chrono?s=${s}&records=1`, { cache: "no-store" });
    if (!res.ok) return null;
    const body = (await res.json()) as { entries?: unknown };
    return Array.isArray(body.entries) ? (body.entries as ServerEntry[]) : null;
  } catch {
    return null;
  }
}
