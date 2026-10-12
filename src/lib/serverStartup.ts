// Le démarrage du lecteur serveur, étape par étape (DECISIONS.md §77).
//
// « Pas de première image en 20 s » ne disait pas où les vingt secondes étaient passées : la
// négociation, la liste maître (920 Ko non compressés le 12/10/2026, sur un lien à 40 Ko/s), la
// liste de variante, le premier segment, son décodage. Chaque négociation tient ici ses instants,
// comptés depuis la demande (`POST /playback/start`), et les lignes `start`, `error` et `stop` du
// lecteur serveur les portent sous `startup.*` — avec, pour un échec, l'étape où il en était.
//
// Deux sources : les événements d'hls.js et leurs `stats` (Chrome, Firefox, Edge) ; en HLS natif
// (Safari), `performance.getEntriesByType("resource")` sur les adresses du flux, au mieux — le
// moteur de Safari charge lui-même, et ce que la page en voit dépend de lui.
//
// Mesure seulement : rien ici ne lève, jamais.

/** L'étape atteinte : la liste, un segment, son décodage, la première image. */
export type StartupStage = "liste" | "segment" | "décodage" | "image";

export interface StartupFacts {
  negotiateMs?: number;
  masterMs?: number;
  masterKB?: number;
  variantMs?: number;
  variantKB?: number;
  fragAskedMs?: number;
  fragMs?: number;
  fragKB?: number;
  fragMbps?: number;
  bufferedMs?: number;
  pictureMs?: number;
}

const round = (v: number) => Math.round(v);
const kb = (bytes: number) => Math.round(bytes / 100) / 10;

/** Les `stats` d'un chargement d'hls.js (`LoaderStats`) — seuls les champs lus ici. */
interface LoadStatsLike {
  loaded?: number;
  total?: number;
  loading?: { start?: number; first?: number; end?: number };
}

export class ServerStartup {
  private readonly facts: StartupFacts = {};
  /** `performance.now()` à la demande — la base de tous les instants. */
  constructor(private readonly t0: number, private readonly clock: () => number = () => performance.now()) {}

  private since(at?: number): number | undefined {
    return typeof at === "number" && Number.isFinite(at) && at > 0 ? round(at - this.t0) : undefined;
  }

  private now(): number {
    return round(this.clock() - this.t0);
  }

  negotiated(): void {
    this.safe(() => (this.facts.negotiateMs ??= this.now()));
  }

  /** `MANIFEST_LOADED` : la liste maître. */
  master(stats: LoadStatsLike | undefined): void {
    this.safe(() => {
      if (this.facts.masterMs !== undefined) return;
      this.facts.masterMs = this.since(stats?.loading?.end) ?? this.now();
      const bytes = stats?.loaded ?? stats?.total;
      if (typeof bytes === "number" && bytes > 0) this.facts.masterKB = kb(bytes);
    });
  }

  /** `LEVEL_LOADED` : la liste de variante (celle qui énumère les segments). */
  variant(stats: LoadStatsLike | undefined): void {
    this.safe(() => {
      if (this.facts.variantMs !== undefined) return;
      this.facts.variantMs = this.since(stats?.loading?.end) ?? this.now();
      const bytes = stats?.loaded ?? stats?.total;
      if (typeof bytes === "number" && bytes > 0) this.facts.variantKB = kb(bytes);
    });
  }

  /** `FRAG_LOADING` : le premier segment demandé. */
  fragAsked(): void {
    this.safe(() => (this.facts.fragAskedMs ??= this.now()));
  }

  /** `FRAG_LOADED` : le premier segment reçu, ses octets et son débit. */
  fragLoaded(stats: LoadStatsLike | undefined, payloadBytes?: number): void {
    this.safe(() => {
      if (this.facts.fragMs !== undefined) return;
      const end = stats?.loading?.end;
      this.facts.fragMs = this.since(end) ?? this.now();
      const bytes = stats?.loaded || stats?.total || payloadBytes || 0;
      if (bytes > 0) {
        this.facts.fragKB = kb(bytes);
        const from = stats?.loading?.first || stats?.loading?.start;
        if (typeof from === "number" && typeof end === "number" && end > from) {
          this.facts.fragMbps = Math.round(((bytes * 8) / ((end - from) / 1000) / 1e6) * 10) / 10;
        }
      }
    });
  }

  /** `FRAG_BUFFERED` : le premier segment accepté par le tampon. */
  buffered(): void {
    this.safe(() => (this.facts.bufferedMs ??= this.now()));
  }

  /** `loadeddata` : la première image. */
  picture(): void {
    this.safe(() => (this.facts.pictureMs ??= this.now()));
  }

  /**
   * Safari, HLS natif : ce que les entrées de ressources disent des adresses du flux (`/api/
   * jellyfin/stream/…`) parties depuis la demande. La première liste est la maître, la suivante la
   * variante, le premier fichier qui n'est pas une liste le premier segment. Ne remplace rien de
   * déjà connu par les événements d'hls.js.
   */
  fromResources(entries: readonly PerformanceEntry[], streamPrefix: string): void {
    this.safe(() => {
      const ours = entries
        .filter((e): e is PerformanceResourceTiming => typeof (e as PerformanceResourceTiming).responseEnd === "number")
        .filter((e) => e.startTime >= this.t0 && e.name.includes(streamPrefix))
        .sort((a, b) => a.startTime - b.startTime);
      const size = (e: PerformanceResourceTiming) => e.encodedBodySize || e.transferSize || 0;
      const lists = ours.filter((e) => /\.m3u8$/.test(new URL(e.name, "http://x").pathname));
      const segments = ours.filter((e) => !lists.includes(e));
      const [master, variant] = lists;
      if (master && this.facts.masterMs === undefined) {
        this.facts.masterMs = round(master.responseEnd - this.t0);
        if (size(master)) this.facts.masterKB = kb(size(master));
      }
      if (variant && this.facts.variantMs === undefined) {
        this.facts.variantMs = round(variant.responseEnd - this.t0);
        if (size(variant)) this.facts.variantKB = kb(size(variant));
      }
      const frag = segments[0];
      if (frag && this.facts.fragMs === undefined) {
        this.facts.fragAskedMs ??= round(frag.startTime - this.t0);
        this.facts.fragMs = round(frag.responseEnd - this.t0);
        const bytes = size(frag);
        if (bytes) {
          this.facts.fragKB = kb(bytes);
          const from = frag.responseStart || frag.startTime;
          if (frag.responseEnd > from) this.facts.fragMbps = Math.round(((bytes * 8) / ((frag.responseEnd - from) / 1000) / 1e6) * 10) / 10;
        }
      }
    });
  }

  /** L'étape où en est le démarrage : la dernière atteinte, ou celle qu'on attend. */
  stage(): StartupStage {
    const f = this.facts;
    if (f.pictureMs !== undefined) return "image";
    if (f.bufferedMs !== undefined || f.fragMs !== undefined) return f.bufferedMs !== undefined ? "image" : "décodage";
    if (f.variantMs !== undefined || f.fragAskedMs !== undefined) return "segment";
    return "liste";
  }

  /** Pour une ligne : `{ startup: {...} }`, que la route aplatit en `startup.*`. */
  fields(withStage = false): Record<string, unknown> {
    try {
      const facts: Record<string, number | string> = { ...this.facts } as Record<string, number>;
      if (withStage) facts.stage = this.stage();
      return Object.keys(facts).length ? { startup: facts } : {};
    } catch {
      return {};
    }
  }

  private safe(fn: () => void): void {
    try {
      fn();
    } catch {
      /* une mesure n'est pas une lecture */
    }
  }
}

/** Les entrées de ressources de la page, ou rien. */
export function resourceEntries(): readonly PerformanceEntry[] {
  try {
    return typeof performance !== "undefined" && typeof performance.getEntriesByType === "function" ? performance.getEntriesByType("resource") : [];
  } catch {
    return [];
  }
}
