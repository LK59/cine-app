/**
 * La position d'une diffusion, déduite par le serveur quand la page s'est tue — DECISIONS.md §64.
 *
 * Une diffusion vit sur le téléviseur, mais sa reprise est rapportée à Jellyfin par la page qui l'a
 * lancée (`usePlaybackSession`, toutes les dix secondes). Que cette page se taise — un iPhone
 * verrouillé qui suspend son JavaScript, iOS qui tue l'application, un ordinateur mis en veille, un
 * onglet fermé — et le film continue sur la télé sans que rien ne soit plus gardé : on reprenait
 * ensuite à l'instant où la page s'était tue, une heure plus tôt parfois.
 *
 * Le serveur, lui, voit passer chaque segment que le téléviseur demande, avec son laissez-passer
 * (film + compte). Jellyfin écrit dans l'adresse de chaque segment sa position dans le film
 * (`runtimeTicks`, relevé sur le vrai serveur le 11/10/2026 : `hls1/main/12.mp4?…&runtimeTicks=
 * 360000000&actualSegmentLengthTicks=30000000`). D'où la position approximative, rapportée à
 * Jellyfin pour ce compte avec la même fonction que le filet d'un jeton refusé (`saveAsAdmin`) :
 * position en cours de route, seuils vu/reprise de Jellyfin à l'arrêt.
 *
 * Les règles, chacune pour une raison :
 *
 *   - **Ne jamais concurrencer la page.** Tant qu'elle a rapporté ce titre pour ce compte dans la
 *     dernière minute (`notePageReport`, appelé par les routes `playing`/`progress`/`stop`), le
 *     serveur se tait : la page connaît la position exacte, lui ne fait que l'estimer.
 *   - **Une marge de 30 s.** Le récepteur charge en avance — le lecteur du récepteur Cast vise une
 *     trentaine de secondes de tampon, une Apple TV autant ou plus. Le dernier segment demandé est
 *     donc devant l'image ; s'en tenir en deçà fait au pire revoir quelques secondes à la reprise,
 *     alors qu'en surestimer ferait sauter de la scène. On retranche donc la marge.
 *   - **Un rapport toutes les 30 s au plus par diffusion**, et un état en mémoire borné et purgé.
 *   - **Jamais sans laissez-passer** : seule la route du flux appelle `noteCastSegment`, et
 *     seulement pour une requête qui en porte un valable. Le lecteur natif et le lecteur serveur dans
 *     la page ne passent jamais par ici.
 *   - **L'arrêt.** Quand plus rien n'est demandé pendant 90 s (fin du film, télé éteinte, longue
 *     pause) et que la page reste muette, l'arrêt est rapporté à la dernière position déduite :
 *     Jellyfin applique ses seuils — un film fini est marqué vu. Un arrêt prématuré (une pause de
 *     plus de 90 s) ne coûte rien : il n'écrit qu'une position, et la diffusion qui reprend en
 *     rapporte de nouvelles.
 *   - **Une ligne au journal** quand le serveur prend le relais, et une à l'arrêt (`serverRelay`),
 *     que la page Activité rattache à la séance du compte et du titre.
 */

import { saveAsAdmin } from "@/lib/playbackReport";
import { logPlaybackEvent } from "@/lib/playerLog";
import { logError } from "@/lib/logger";

/** Ce qu'on retranche du début du segment demandé — voir l'en-tête. */
export const CAST_BUFFER_MARGIN_SECONDS = 30;
/** Une page qui a rapporté ce titre depuis moins que cela est vivante : le serveur se tait. */
// 150 s et non 60 (chasse aux bugs du 11/10/2026) : une page EN PAUSE ne bat qu'une fois la
// minute, sur un minuteur de 10 s — 60 à 70 s entre deux battements (`usePlaybackSession`). À 60 s,
// une page ouverte passait pour muette jusqu'à 10 s par minute, et le relais parlait par-dessus.
export const PAGE_FRESH_MS = 150_000;
/** Au plus un rapport par diffusion dans cet intervalle. */
export const REPORT_EVERY_MS = 30_000;
/** Plus aucun segment depuis cela, page muette : l'arrêt est rapporté. */
export const SILENCE_STOP_MS = 90_000;
/** Une diffusion jamais relayée et sans nouvelles depuis cela est oubliée. */
export const IDLE_FORGET_MS = 10 * 60_000;
/** Le nombre d'entrées gardées au plus — les plus anciennes partent d'abord. */
export const MAX_ENTRIES = 500;
/** Le passage de ménage. */
const SWEEP_EVERY_MS = 30_000;

const TICKS_PER_SECOND = 10_000_000;

/**
 * Où commence ce segment dans le film, en secondes — ou `null` si l'adresse n'est pas celle d'un
 * segment vidéo numéroté portant sa position (`runtimeTicks`). Le segment d'initialisation (`-1`),
 * les manifestes et les sous-titres ne disent rien de la lecture.
 */
export function segmentStartSeconds(restPath: string, search: URLSearchParams): number | null {
  if (!/(^|\/)\d+\.(mp4|m4s|ts)$/.test(restPath)) return null;
  const raw = search.get("runtimeTicks");
  if (raw === null || !/^\d+$/.test(raw)) return null;
  const ticks = Number(raw);
  return Number.isFinite(ticks) ? ticks / TICKS_PER_SECOND : null;
}

/** La position rapportée pour un segment qui commence là : la marge retranchée, jamais sous zéro. */
export function deducedPosition(segmentStart: number): number {
  return Math.max(0, segmentStart - CAST_BUFFER_MARGIN_SECONDS);
}

type Kind = "progress" | "stop";

export interface CastProgressDeps {
  save: (jfId: string, itemId: string, kind: Kind, positionTicks: number) => Promise<string>;
  log: (user: string, fields: Record<string, unknown>) => void;
}

interface Entry {
  jfId: string;
  user: string;
  itemId: string;
  position: number;
  lastSegmentAt: number;
  lastReportAt: number;
  relaying: boolean;
}

const key = (jfId: string, itemId: string) => `${jfId}:${itemId}`;

/** Le relais, avec son état ; une instance par serveur (`castProgressRelay`), d'autres en test. */
export class CastProgressRelay {
  private readonly entries = new Map<string, Entry>();
  private readonly pageSeen = new Map<string, number>();

  constructor(private readonly deps: CastProgressDeps) {}

  /** La page a rapporté ce titre pour ce compte — le serveur se tait pour la minute qui vient. */
  notePageReport(jfId: string, itemId: string, now = Date.now()): void {
    const k = key(jfId, itemId);
    // La page reparle : c'est elle qui fait foi. Une diffusion que le serveur relayait est oubliée —
    // gardée, elle envoyait 90 s plus tard un « arrêt » à la vieille position du téléviseur, par-dessus
    // l'arrêt juste de la page revenue lire en local (chasse aux bugs du 11/10/2026). Si le
    // téléviseur continue et que la page se tait de nouveau, le prochain segment la recrée.
    if (this.entries.get(k)?.relaying) this.entries.delete(k);
    this.pageSeen.delete(k);
    this.pageSeen.set(k, now);
    this.trim(this.pageSeen);
  }

  private pageAlive(k: string, now: number): boolean {
    const seen = this.pageSeen.get(k);
    return seen !== undefined && now - seen < PAGE_FRESH_MS;
  }

  /**
   * Un segment servi à un laissez-passer. Retient la position ; la rapporte si la page s'est tue et
   * que le dernier rapport date d'au moins 30 s. Ne lève jamais — on est sur le chemin du flux.
   */
  noteCastSegment(pass: { jfId: string | null; user: string; itemId: string; restPath: string; search: URLSearchParams }, now = Date.now()): void {
    try {
      if (!pass.jfId) return;
      const start = segmentStartSeconds(pass.restPath, pass.search);
      if (start === null) return;
      const k = key(pass.jfId, pass.itemId);
      const previous = this.entries.get(k);
      const entry: Entry = previous ?? { jfId: pass.jfId, user: pass.user, itemId: pass.itemId, position: 0, lastSegmentAt: now, lastReportAt: 0, relaying: false };
      entry.position = deducedPosition(start);
      entry.lastSegmentAt = now;
      // Ré-inséré en fin de liste : l'entrée la plus récemment vue part la dernière.
      this.entries.delete(k);
      this.entries.set(k, entry);
      this.trim(this.entries);
      if (this.pageAlive(k, now) || now - entry.lastReportAt < REPORT_EVERY_MS) return;
      entry.lastReportAt = now;
      if (!entry.relaying) {
        entry.relaying = true;
        this.deps.log(entry.user, {
          itemId: entry.itemId,
          player: "serveur",
          cast: true,
          serverRelay: true,
          reason: "relais du serveur — position déduite des segments",
          at: Math.round(entry.position),
        });
      }
      this.send(entry, "progress");
    } catch {
      // Le flux passe avant tout.
    }
  }

  /** Le ménage : l'arrêt des diffusions muettes, l'oubli des entrées sans relais. */
  sweep(now = Date.now()): void {
    for (const [k, entry] of this.entries) {
      const silent = now - entry.lastSegmentAt;
      if (entry.relaying && silent >= SILENCE_STOP_MS && !this.pageAlive(k, now)) {
        this.entries.delete(k);
        this.deps.log(entry.user, {
          itemId: entry.itemId,
          player: "serveur",
          cast: true,
          serverRelay: true,
          reason: "relais du serveur — arrêt",
          at: Math.round(entry.position),
        });
        this.send(entry, "stop");
      } else if (!entry.relaying && silent >= IDLE_FORGET_MS) {
        this.entries.delete(k);
      } else if (entry.relaying && silent >= IDLE_FORGET_MS) {
        // La page est revenue et a tout repris : plus rien à arrêter de notre côté.
        this.entries.delete(k);
      }
    }
    for (const [k, seen] of this.pageSeen) if (now - seen >= IDLE_FORGET_MS) this.pageSeen.delete(k);
  }

  /** Pour les tests : l'état d'une diffusion. */
  entry(jfId: string, itemId: string): Readonly<Entry> | undefined {
    return this.entries.get(key(jfId, itemId));
  }

  get size(): number {
    return this.entries.size;
  }

  private send(entry: Entry, kind: Kind): void {
    const ticks = Math.floor(entry.position * TICKS_PER_SECOND);
    void this.deps.save(entry.jfId, entry.itemId, kind, ticks).catch((error: unknown) => {
      logError("cast-relay", error, { user: entry.user, itemId: entry.itemId, kind });
    });
  }

  private trim<V>(map: Map<string, V>): void {
    while (map.size > MAX_ENTRIES) {
      const oldest = map.keys().next().value;
      if (oldest === undefined) break;
      map.delete(oldest);
    }
  }
}

let shared: CastProgressRelay | null = null;
let timer: ReturnType<typeof setInterval> | null = null;

/** Le relais du serveur, créé au premier usage avec son passage de ménage (qui ne retient pas le processus). */
export function castProgressRelay(): CastProgressRelay {
  if (!shared) {
    shared = new CastProgressRelay({
      save: (jfId, itemId, kind, ticks) => saveAsAdmin(jfId, itemId, kind, ticks),
      log: (user, fields) => logPlaybackEvent(user, "cast", fields),
    });
    timer = setInterval(() => shared?.sweep(), SWEEP_EVERY_MS);
    (timer as { unref?: () => void }).unref?.();
  }
  return shared;
}
