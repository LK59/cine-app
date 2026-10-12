// La chronologie récente d'une lecture, gardée en mémoire et jointe aux lignes qui racontent une
// panne (DECISIONS.md §77).
//
// Le journal disait *qu'une* lecture avait déraillé, rarement ce qui se passait juste avant : les
// lignes `reserve` sont espacées (départ, changement rafale/repos, au plus toutes les 5 min — la
// décision du 08/10/2026 de ne plus en envoyer toutes les 30 s tient), et une ligne `stall` ne voit
// que sa propre fenêtre. Ici, toutes les 5 s, un échantillon compact — position du film, instant,
// débit reçu sur ces 5 s, tampon devant, réserve en mémoire, état — dans un anneau des 24 derniers
// (deux minutes). **Rien ne part sur le réseau pour lui** : l'anneau voyage sur les lignes qui
// partent de toute façon (`stall`, `error`, `fallback`, `rebuild`, `network`, `stop`), sous le seul
// champ `timeline`, une chaîne — `reportPlayback` l'y ajoute (`timelineFields`).
//
// Format, du plus ancien au plus récent, séparés par « ; » :
//   position s , secondes depuis le départ , Mb/s reçus (ou -) , s de tampon devant (ou -) ,
//   Mo de réserve (ou -) , état
// État : L lecture, A attente, P pause, S saut, H arrière-plan (page cachée).
// Exemple : « 1001,240,2.1,12.5,0,L;1006,245,0.3,7.4,0,L;1006,250,0,2.4,0,A ».
//
// Mesure seulement : rien ici ne lève, jamais.

/** Un échantillon. `null` : la grandeur n'est pas connue sur ce chemin (Safari HLS : pas de débit). */
export interface TimelineSample {
  /** Position du film, en secondes. */
  pos: number;
  /** Millisecondes depuis le départ de la séance. */
  wall: number;
  recvMbps: number | null;
  aheadS: number | null;
  reserveMB: number | null;
  state: TimelineState;
}

export type TimelineState = "L" | "A" | "P" | "S" | "H";

/** La cadence : assez fine pour situer une panne à quelques secondes, assez lâche pour ne rien coûter. */
export const TIMELINE_EVERY_MS = 5_000;
/** L'anneau : deux minutes — ce qui précède un blocage et l'explique, sans plus. */
export const TIMELINE_KEEP = 24;
/**
 * Le plafond du champ côté route (`playerLog.ts` le borne à part, comme `steps`) : 24 échantillons
 * d'au plus ~30 caractères. Au-delà, les plus anciens sont retirés, jamais les derniers.
 */
export const TIMELINE_MAX_CHARS = 1_000;

/** Les lignes qui emportent l'anneau : celles qui racontent une panne, et le bilan. */
export const TIMELINE_KINDS: ReadonlySet<string> = new Set(["stall", "error", "fallback", "rebuild", "network", "stop"]);

function fixed(value: number | null, digits: number): string {
  if (value === null || !Number.isFinite(value)) return "-";
  const rounded = Number(value.toFixed(digits));
  return String(rounded);
}

export function formatSample(s: TimelineSample): string {
  return [fixed(s.pos, 0), fixed(s.wall / 1000, 0), fixed(s.recvMbps, 1), fixed(s.aheadS, 1), fixed(s.reserveMB, 0), s.state].join(",");
}

/** L'état d'un élément vidéo, tel que l'anneau le note. */
export function elementState(video: HTMLVideoElement | null | undefined, waiting = false): TimelineState {
  try {
    if (typeof document !== "undefined" && document.visibilityState === "hidden") return "H";
    if (!video) return "A";
    if (video.seeking) return "S";
    if (video.paused) return "P";
    if (waiting || video.readyState < 3) return "A";
    return "L";
  } catch {
    return "A";
  }
}

/** Les secondes chargées devant la tête de lecture, d'après `buffered`. */
export function bufferedAhead(video: HTMLVideoElement | null | undefined): number | null {
  try {
    if (!video) return null;
    const at = video.currentTime;
    const ranges = video.buffered;
    for (let i = 0; i < ranges.length; i++) {
      if (ranges.start(i) <= at + 0.25 && ranges.end(i) > at) return Math.max(0, ranges.end(i) - at);
    }
    return 0;
  } catch {
    return null;
  }
}

/**
 * L'anneau d'une séance. `sample` rend l'échantillon de l'instant (sans `wall`, posé ici) ou `null`
 * quand il n'y a rien à noter ; une exception y est avalée.
 */
export class PlaybackTimeline {
  private readonly ring: TimelineSample[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly startedAt: number;

  constructor(
    private readonly sample: () => Omit<TimelineSample, "wall"> | null,
    private readonly clock: () => number = () => Date.now(),
    private readonly everyMs = TIMELINE_EVERY_MS,
    private readonly keep = TIMELINE_KEEP
  ) {
    this.startedAt = this.clock();
  }

  start(): this {
    try {
      if (this.timer === null) this.timer = setInterval(() => this.take(), this.everyMs);
    } catch {
      /* une mesure n'est pas une lecture */
    }
    return this;
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  /** Un échantillon maintenant — la minuterie, et un dernier au moment d'écrire une panne. */
  take(): void {
    try {
      const s = this.sample();
      if (!s) return;
      this.ring.push({ ...s, wall: this.clock() - this.startedAt });
      if (this.ring.length > this.keep) this.ring.splice(0, this.ring.length - this.keep);
    } catch {
      /* un échantillon de moins */
    }
  }

  samples(): readonly TimelineSample[] {
    return this.ring;
  }

  /** La forme compacte, bornée par le début : les échantillons récents sont ceux qui comptent. */
  compact(): string {
    try {
      const parts = this.ring.map(formatSample);
      while (parts.length > 1 && parts.join(";").length > TIMELINE_MAX_CHARS) parts.shift();
      return parts.join(";");
    } catch {
      return "";
    }
  }
}

// --- le registre : l'anneau de la séance qui écrit ------------------------------------------------

/**
 * Par identifiant de séance. Le lecteur natif et le lecteur serveur qui prend son relais partagent
 * l'identifiant : le dernier inscrit l'emporte, et chacun ne retire que le sien.
 */
const active = new Map<string, PlaybackTimeline>();

export function registerTimeline(session: string, timeline: PlaybackTimeline): () => void {
  active.set(session, timeline);
  return () => {
    if (active.get(session) === timeline) active.delete(session);
  };
}

/**
 * Le champ `timeline` d'une ligne, si elle en emporte un et que sa séance a un anneau — un dernier
 * échantillon pris à l'instant, pour que la panne elle-même y figure. Rien sinon.
 */
export function timelineFields(kind: string, fields: Record<string, unknown>): Record<string, string> {
  try {
    if (!TIMELINE_KINDS.has(kind) || typeof fields.session !== "string" || "timeline" in fields) return {};
    const timeline = active.get(fields.session);
    if (!timeline) return {};
    timeline.take();
    const compact = timeline.compact();
    return compact ? { timeline: compact } : {};
  } catch {
    return {};
  }
}

/** Relit un champ `timeline` pour le panneau Activité. Les morceaux illisibles sont ignorés. */
export function parseTimeline(text: unknown): TimelineSample[] {
  if (typeof text !== "string" || !text) return [];
  const num = (v: string | undefined) => (v === undefined || v === "-" || v === "" ? null : Number.isFinite(Number(v)) ? Number(v) : null);
  const out: TimelineSample[] = [];
  for (const part of text.split(";")) {
    const [pos, wall, recv, ahead, reserve, state] = part.split(",");
    const p = num(pos);
    const w = num(wall);
    if (p === null || w === null || !state || !"LAPSH".includes(state)) continue;
    out.push({ pos: p, wall: w * 1000, recvMbps: num(recv), aheadS: num(ahead), reserveMB: num(reserve), state: state as TimelineState });
  }
  return out;
}

/** Pour les tests. */
export function clearTimelines(): void {
  active.clear();
}
