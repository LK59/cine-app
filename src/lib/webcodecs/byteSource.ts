import { trace } from "./trace";
// Random access over a media file, for the experimental WebCodecs player.
//
// The demuxer needs to jump around a file that can be 40 GB: read the header, jump to the end
// for the index, then stream clusters from wherever the user seeks. HTTP range requests give
// exactly that, and the existing Jellyfin stream proxy already forwards Range headers for the
// static (non-transcoded) endpoint — so the original file is reachable with no new route and no
// ffmpeg anywhere in the path.
//
// Everything above this interface is testable without a network: the demuxer only ever sees
// `size` and `read()`, so its tests feed it a Uint8Array.

export interface ByteSource {
  /** Total length of the file in bytes. */
  readonly size: number;
  /** Reads exactly [offset, offset+length), clamped at EOF. */
  read(offset: number, length: number): Promise<Uint8Array>;
  /**
   * Starts fetching around an offset nothing has asked for yet.
   *
   * Optional: a source already holding the whole file has nothing to warm. For one reading over
   * the network it is the difference between a seek that begins with a single request on an idle
   * link and one that begins with the link full.
   */
  warm?(offset: number): void;
  /**
   * Une plage à garder en mémoire de préférence — celle autour de la tête de lecture. Optionnel,
   * et une préférence, pas une réservation : rien n'est téléchargé pour elle.
   */
  keep?(from: number, to: number): void;
  /**
   * Abandonne les lectures réseau en cours loin de `keepOffset` — la position où l'on saute.
   * Celui qui les attendait reçoit `ReadAbandoned`. Optionnel : une source en mémoire n'a rien en
   * vol.
   */
  abandon?(keepOffset: number): void;
  /** Le saut a sa première image : la lecture en avance reprend en entier. Optionnel. */
  seekSettled?(): void;
  /** Le réseau depuis le dernier saut (`abandon`) — voir `NetworkWindow`. Optionnel. */
  networkSinceSeek?(): NetworkWindow | null;
  /** Releases any pending work. Safe to call twice. */
  close(): void;
}

/**
 * A window of another source, already in memory, addressed by the SAME absolute offsets.
 *
 * Parsing a container element field by field means one read per field — 129 000 of them for a
 * film with 15 000 cue points, measured. Each is cheap on its own but they are all awaited. When
 * an element is known to be small enough to hold whole (Tracks, Cues), reading it once and
 * parsing out of the buffer turns those thousands of reads into one, with no change to the
 * parsing code: it keeps handing out the same absolute offsets.
 */
export class SlicedSource implements ByteSource {
  constructor(private readonly bytes: Uint8Array, private readonly base: number, readonly size: number) {}

  static async of(source: ByteSource, start: number, end: number): Promise<SlicedSource> {
    const bytes = await source.read(start, end - start);
    return new SlicedSource(bytes, start, source.size);
  }

  async read(offset: number, length: number): Promise<Uint8Array> {
    const from = offset - this.base;
    const start = Math.max(0, Math.min(from, this.bytes.length));
    const to = Math.max(start, Math.min(from + length, this.bytes.length));
    return this.bytes.subarray(start, to);
  }

  close(): void {}
}

export class MemoryByteSource implements ByteSource {
  constructor(private readonly bytes: Uint8Array) {}
  get size() {
    return this.bytes.length;
  }
  async read(offset: number, length: number): Promise<Uint8Array> {
    const start = Math.max(0, Math.min(offset, this.bytes.length));
    const end = Math.max(start, Math.min(offset + length, this.bytes.length));
    return this.bytes.subarray(start, end);
  }
  close(): void {}
}

// Reads are coalesced into fixed-size chunks and cached: a demuxer asks for a 4-byte element
// header, then a 3-byte size, then a payload — issuing an HTTP request per call would be
// thousands of round-trips. One chunk fetch answers hundreds of those.
const CHUNK_SIZE = 1 << 20; // 1 MiB

/**
 * How many chunks to keep. Enough to cover a seek's working set, and a ceiling on the memory a
 * long film can quietly accumulate.
 */
const MAX_CACHED_CHUNKS = 64; // ~64 MiB

/**
 * **La zone autour de la tête de lecture, gardée — ajoutée le 21/09/2026.**
 *
 * Le cache évinçait le plus ancien morceau d'abord. Or le lecteur lit en avance, jusqu'à trente
 * secondes : les 48 Mo gardés étaient surtout l'*avenir* du film, et l'endroit qu'on regarde avait
 * été chassé depuis longtemps. Changer de piste audio, c'est justement relire cet endroit — le son
 * y est entrelacé avec l'image —, donc tout retélécharger : 9 s mesurées sur iPhone ce jour-là, sur
 * une connexion lente. Le lecteur désigne maintenant la zone à garder (`keep`), et l'éviction passe
 * par-dessus ; le cache a grandi de seize mégaoctets pour que cette zone ne mange pas l'avance.
 *
 * Bornée : jamais plus de `MAX_KEPT_CHUNKS`, quoi que demande l'appelant — un fichier dont les
 * images clés sont à vingt-cinq secondes d'intervalle ne doit pas figer tout le cache.
 */
const MAX_KEPT_CHUNKS = 24;

/**
 * How far ahead to fetch, in chunks.
 *
 * One was not a pipeline, it was a relay: chunk N being consumed while N+1 was in flight, and
 * every megabyte after that paying a fresh round trip before its first byte arrived. Reading one
 * keyframe group means five or six of these, and on the phone that came to 2.6 seconds against
 * 40 ms of actual muxing — the wait was almost entirely the shape of the fetching.
 *
 * Six is chosen against what the reader is for: the fill loop wants thirty seconds of media, which
 * on this library is twenty megabytes, so six ahead is never speculative in the sense of being
 * thrown away. It is only ever bytes that were going to be asked for a moment later.
 */
const PREFETCH_CHUNKS = 6;

/**
 * Et juste après un saut, tant que sa première image n'est pas là : deux seulement.
 *
 * Banc du 22/09/2026, serveur lointain à 75 Mb/s : 11 à 21 Mo transférés avant la première image
 * d'un saut qui n'en demandait que 4 à 6. Les six morceaux lus en avance partageaient le lien avec
 * celui que le lecteur attendait, qui n'en recevait qu'une part sur sept. Deux suffisent à garder
 * le lien plein (un aller-retour de 60 ms à 75 Mb/s, c'est un demi-mégaoctet en vol) ; l'avance
 * entière reprend dès que le saut a son image (`seekSettled`).
 */
const SEEK_PREFETCH_CHUNKS = 2;

/** Au-delà, l'avance entière reprend d'elle-même : un saut qui n'aboutit pas ne la bride pas. */
const SEEK_FOCUS_MS = 8000;

/**
 * How a chunk that fails to arrive is retried.
 *
 * A range request is not a stream: nothing resumes it, and one refused fetch used to travel all
 * the way up as a read failure — through the fill loop, through the recovery, and out the other
 * side as the player giving up. A phone changing from Wi-Fi to mobile drops every connection it
 * has, which is a perfectly ordinary thing to do while watching a film and no reason at all to
 * abandon hardware decoding for the rest of it.
 */
const FETCH_ATTEMPTS = 4;
const FETCH_BACKOFF_MS = [200, 600, 1500];

/**
 * Le temps qu'une plage a pour arriver — et ce qui manquait à tout le reste pour fonctionner.
 *
 * Les quatre tentatives ci-dessus, l'attente du retour du réseau, l'écran « Connexion perdue »
 * avec son bouton, la reprise automatique à la position exacte : tout cela existait déjà et rien
 * ne s'armait dans un cas précis, qui est justement le plus courant sur un téléphone. Une bascule
 * Wi-Fi → 5G ne *refuse* pas les connexions en cours, elle les laisse **pendre** : la socket ne
 * répond plus et ne se ferme pas. Sans échéance, ce `fetch` ne se résout jamais — pas d'erreur,
 * donc pas de nouvelle tentative, donc pas d'écran, donc une image figée pour toujours.
 *
 * Vingt-cinq secondes pour un mégaoctet, soit quarante-deux kilo-octets par seconde. C'est le
 * point qui rend ce garde-fou incapable de nuire : un flux remultiplexé demande plusieurs
 * centaines de kilo-octets par seconde pour tenir, donc en dessous de ce seuil la lecture est de
 * toute façon perdue. Une connexion lente mais réelle ne peut pas être coupée par cette échéance ;
 * seule une connexion morte l'atteint.
 */
const REQUEST_TIMEOUT_MS = 25_000;

/**
 * L'échéance, ajoutée à l'annulation du lecteur — quand le navigateur sait les combiner.
 *
 * `AbortSignal.any` date de Safari 17.4 et de Chrome 116. Là où il manque, on rend le signal du
 * lecteur seul : on perd l'échéance, pas la lecture. Dégradé, jamais cassé — c'est la règle de ce
 * dossier pour tout ce qui dépend d'une capacité du navigateur.
 */
function readSignal(playerSignal: AbortSignal): AbortSignal {
  const any = (AbortSignal as { any?: (signals: AbortSignal[]) => AbortSignal }).any;
  if (typeof any !== "function" || typeof AbortSignal.timeout !== "function") return playerSignal;
  return any([playerSignal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]);
}

/** How long a read waits for the network to come back before admitting it is not going to. */
const OFFLINE_PATIENCE_MS = 60_000;

/**
 * A read that failed for want of a network, told apart from one that failed for want of sense.
 *
 * The difference decides what happens next, and getting it wrong is worse than either: handing
 * the file to the stable player because the Wi-Fi dropped abandons hardware decoding for a
 * reason that has nothing to do with it — and hands the file to a player that needs the very
 * same network to do anything at all.
 */
export class NetworkUnavailable extends Error {
  readonly network = true;
  constructor(message: string) {
    super(message);
    this.name = "NetworkUnavailable";
  }
}

/**
 * Ce que le réseau a fait depuis le dernier saut : de quoi dire, d'un saut lent, si c'était le
 * trajet, le relais ou Jellyfin (22/09/2026 : sauts de dix secondes depuis un serveur lointain
 * pour quelques mégaoctets, alors que le serveur servait la même plage en vingt millisecondes).
 */
export interface NetworkWindow {
  /** Requêtes terminées depuis le saut. */
  requests: number;
  bytes: number;
  /** Du saut à la fin de la dernière requête terminée. */
  elapsedMs: number;
  /** Délai jusqu'aux en-têtes (premier octet), le plus court et le plus long. */
  firstByteMinMs: number;
  firstByteMaxMs: number;
  /** La plus longue requête, de l'envoi au dernier octet. */
  slowestMs: number;
  /** Le temps passé côté serveur, d'après `Server-Timing` (`app`) — le plus long vu. */
  serverMaxMs: number | null;
  /**
   * Le protocole de chaque requête — `h2`, `h3`, `http/1.1` —, compté. Vide quand le navigateur
   * ne le dit pas.
   *
   * Un saut lent depuis un serveur lointain se lit autrement selon la réponse : en HTTP/1.1, six
   * connexions au plus par origine, et chaque morceau lu en avance fait la queue derrière les
   * autres ; en HTTP/2, une seule connexion dont les pertes retiennent toutes les requêtes à la
   * fois ; en HTTP/3, ni l'un ni l'autre. Sans ce champ, la trace ne permettait pas de trancher.
   */
  protocols: Record<string, number>;
}

/** La même fenêtre, en une ligne de trace. */
export function describeNetwork(w: NetworkWindow): string {
  const mbps = w.elapsedMs > 0 ? (w.bytes * 8) / (w.elapsedMs / 1000) / 1e6 : 0;
  return (
    `${(w.bytes / 1048576).toFixed(1)} Mo en ${w.elapsedMs} ms (${mbps.toFixed(0)} Mb/s), ${w.requests} requête(s), ` +
    `premier octet ${w.firstByteMinMs}–${w.firstByteMaxMs} ms, la plus lente ${w.slowestMs} ms` +
    (w.serverMaxMs !== null ? `, serveur ≤ ${w.serverMaxMs} ms` : "") +
    describeProtocols(w.protocols)
  );
}

/** `{ h2: 5 }` → `, protocole h2` ; `{ h2: 5, "http/1.1": 1 }` → `, protocoles h2 ×5, http/1.1 ×1`. */
function describeProtocols(protocols: Record<string, number> | undefined): string {
  const seen = Object.entries(protocols ?? {}).sort((a, b) => b[1] - a[1]);
  if (seen.length === 0) return "";
  if (seen.length === 1) return `, protocole ${seen[0][0]}`;
  return `, protocoles ${seen.map(([name, count]) => `${name} ×${count}`).join(", ")}`;
}

/**
 * Le protocole de la dernière requête terminée vers `url`, d'après le Resource Timing du
 * navigateur — ou `null` s'il ne le dit pas.
 *
 * Toutes les plages d'un film ont la même adresse : la dernière entrée de ce nom est donc la
 * requête qu'on vient de finir, ou sa voisine immédiate si le navigateur ne l'a pas encore
 * enregistrée — sur une même origine, le protocole ne change pas d'une requête à l'autre. Le
 * tampon du navigateur s'arrête à quelques centaines d'entrées : passé ce nombre, c'est celui des
 * premières requêtes qu'on lit, ce qui reste la bonne réponse pour la même raison.
 *
 * Ne lève jamais : c'est une mesure, sur le chemin de lecture.
 */
export function protocolOf(url: string): string | null {
  try {
    if (typeof performance === "undefined" || typeof performance.getEntriesByName !== "function") return null;
    // Les entrées sont nommées par l'adresse absolue ; le lecteur demande une adresse relative.
    const name = typeof location !== "undefined" && location?.href ? new URL(url, location.href).href : url;
    const entries = performance.getEntriesByName(name, "resource");
    const last = entries[entries.length - 1] as PerformanceResourceTiming | undefined;
    const protocol = last?.nextHopProtocol;
    return typeof protocol === "string" && protocol !== "" ? protocol : null;
  } catch {
    return null;
  }
}

/** `app;dur=12, jf;dur=8` → 12. */
export function serverTimingApp(header: string | null): number | null {
  const match = header ? /(?:^|,)\s*app;dur=([\d.]+)/.exec(header) : null;
  return match ? Math.round(Number(match[1])) : null;
}

/**
 * Une lecture abandonnée parce que le lecteur est allé ailleurs — ni une panne, ni le réseau.
 *
 * Tout ce qui attendait cette lecture doit s'effacer sans rien réparer : ni nouvelle tentative, ni
 * reprise, ni reconstruction de l'encodeur. Le saut qui l'a causée repositionne tout derrière.
 */
export class ReadAbandoned extends Error {
  readonly abandoned = true;
  constructor() {
    super("lecture abandonnée pour un saut");
    this.name = "ReadAbandoned";
  }
}

export function isReadAbandoned(error: unknown): boolean {
  return error instanceof Error && "abandoned" in error && error.abandoned === true;
}

/** Whether a failure was the network's rather than the media's. */
export function isNetworkFailure(error: unknown): boolean {
  return error instanceof Error && "network" in error && error.network === true;
}

/**
 * Waits for the browser to say it is connected again, up to a point.
 *
 * Retrying while the machine knows it has no network is a way of spending attempts on nothing.
 * Waiting for the event costs neither requests nor battery, and a viewer walking between two
 * networks is back within a second or two.
 */
async function waitForNetwork(signal?: AbortSignal): Promise<void> {
  if (typeof navigator === "undefined" || navigator.onLine !== false) return;
  if (signal?.aborted) return;
  trace("réseau : hors ligne, la lecture attend le retour");
  await new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer);
      window.removeEventListener("online", done);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, OFFLINE_PATIENCE_MS);
    window.addEventListener("online", done, { once: true });
    // A player closed while waiting is a player nobody is waiting for. Without this the minute
    // ran out on its own, holding a timer and a listener for a film already gone from the screen.
    signal?.addEventListener("abort", done, { once: true });
  });
  trace("réseau : de retour");
}

/**
 * Ce qu'une source fermée laisse à la suivante, pour le même fichier.
 *
 * Un changement de piste d'un format à un autre reconstruit le lecteur (voir `perTrack` dans
 * remuxer.ts), et la reconstruction rouvrait tout à zéro : une requête HEAD pour une taille déjà
 * connue — une seconde entière, relevée sur iPhone le 21/09/2026 —, puis tous les octets autour de
 * la tête retéléchargés alors que la source d'avant venait de les avoir. Un fichier ne change pas
 * sous un film qu'on regarde ; sa taille et ses morceaux passent donc de l'une à l'autre.
 *
 * Une seule entrée, et pour quelques secondes : c'est le relais d'une reconstruction — qui rouvre
 * quelques dizaines de millisecondes après avoir fermé —, pas un cache de plus. Court exprès : un
 * fichier que Radarr remplacerait entre deux lectures ne doit pas hériter de la taille de l'ancien,
 * et passé ce délai les quarante-huit mégaoctets sont rendus.
 */
const HANDOVER_MS = 5_000;
type Kept = { first: number; last: number } | null;
let handover: { url: string; size: number; chunks: Map<number, Uint8Array>; kept: Kept; timer: ReturnType<typeof setTimeout> } | null = null;

function takeHandover(url: string): { size: number; chunks: Map<number, Uint8Array>; kept: Kept } | null {
  if (!handover || handover.url !== url) return null;
  const taken = handover;
  clearTimeout(taken.timer);
  handover = null;
  return { size: taken.size, chunks: taken.chunks, kept: taken.kept };
}

function leaveHandover(url: string, size: number, chunks: Map<number, Uint8Array>, kept: Kept): void {
  if (handover) clearTimeout(handover.timer);
  if (chunks.size === 0) {
    handover = null;
    return;
  }
  const timer = setTimeout(() => {
    if (handover?.chunks === chunks) handover = null;
  }, HANDOVER_MS);
  handover = { url, size, chunks, kept, timer };
}

/** Pour les tests : l'état d'une page neuve. */
export function forgetHandover(): void {
  if (handover) clearTimeout(handover.timer);
  handover = null;
}

export class HttpByteSource implements ByteSource {
  /**
   * La taille du fichier — corrigée une fois, si le serveur en annonce une autre que celle avec
   * laquelle la source a été ouverte. Voir `checkTotal`.
   */
  get size(): number {
    return this.total;
  }
  private total: number;
  /** Le total annoncé par une réponse a été lu et comparé : voir `checkTotal`. */
  private totalChecked = false;
  private readonly url: string;
  private chunks = new Map<number, Uint8Array>();
  /** Les morceaux à garder de préférence, bornes comprises — voir `keep`. */
  private kept: Kept = null;
  private readonly inflight = new Map<number, Promise<Uint8Array>>();
  /** L'interrupteur de chaque morceau en vol — pour n'abandonner que ceux qui ne servent plus. */
  private readonly inflightControllers = new Map<number, AbortController>();
  private readonly controller = new AbortController();
  /** Voir `NetworkWindow` : remis à zéro à chaque `abandon`, c'est-à-dire à chaque saut. */
  /** Jusqu'à quand la lecture en avance est bridée — voir `SEEK_PREFETCH_CHUNKS`. */
  private focusUntil = 0;
  /** Le dernier morceau qu'une lecture a demandé : d'où l'avance repart quand le saut aboutit. */
  private lastDemanded = -1;
  private window: {
    since: number;
    requests: number;
    bytes: number;
    lastEnd: number;
    fbMin: number;
    fbMax: number;
    slowest: number;
    server: number | null;
    protocols: Record<string, number>;
  } | null = null;

  private constructor(url: string, size: number) {
    this.url = url;
    this.total = size;
  }

  // The length has to come from the server before anything else can be parsed. HEAD is tried
  // first because it costs nothing; some proxies answer it without Content-Length, in which case
  // a one-byte ranged GET gets the total out of Content-Range instead.
  //
  // Sauf quand l'appelant la connaît déjà (`knownSize`). La description du fichier, que l'hôte a
  // demandée avant d'ouvrir quoi que ce soit, la porte — Jellyfin la tient de son analyse du
  // fichier. Le HEAD coûtait alors un aller-retour entier pour une réponse déjà en main, avant
  // que les deux premières plages puissent même partir : relevé le 22/09/2026 depuis un serveur
  // lointain, ~60 ms d'aller-retour, soit autant de moins à chaque ouverture. Une taille fausse
  // n'est pas crue sur parole : la première réponse la corrige — voir `checkTotal`.
  static async open(url: string, knownSize?: number | null): Promise<HttpByteSource> {
    // Le même fichier que la source qu'on vient de fermer : sa taille et ses morceaux sont déjà
    // là, sans aller-retour — voir `handover`.
    const inherited = takeHandover(url);
    if (inherited) {
      const source = new HttpByteSource(url, inherited.size);
      source.chunks = inherited.chunks;
      // La zone autour de la tête aussi : c'est elle que la reconstruction relit d'abord, et ses
      // premiers téléchargements l'auraient chassée avant que le lecteur ne la redésigne.
      source.kept = inherited.kept;
      trace(`flux repris de la lecture précédente — ${inherited.chunks.size} Mo déjà là`);
      return source;
    }
    if (typeof knownSize === "number" && Number.isFinite(knownSize) && knownSize > 0) {
      // Rien n'est attendu ici : les deux plages partent tout de suite. Un réseau absent se dit
      // donc à la première lecture plutôt qu'à l'ouverture, avec la même erreur nommée
      // (`NetworkUnavailable`, après `waitForNetwork` et les nouvelles tentatives).
      trace(`taille connue d'avance (${Math.floor(knownSize)} octets) — pas de HEAD`);
      return HttpByteSource.warmed(url, Math.floor(knownSize));
    }
    // Named for what it is. A file that cannot be opened because there is no network is not a
    // file this player cannot play, and handing it to a player needing the same network is the
    // one answer that helps nobody.
    const head = await fetch(url, { method: "HEAD" }).catch((cause: unknown) => {
      throw new NetworkUnavailable(cause instanceof Error ? cause.message : "réseau indisponible");
    });
    const headLength = Number(head.headers.get("Content-Length"));
    if (head.ok && Number.isFinite(headLength) && headLength > 0) {
      return HttpByteSource.warmed(url, headLength);
    }

    const probe = await fetch(url, { headers: { Range: "bytes=0-0" } }).catch((cause: unknown) => {
      throw new NetworkUnavailable(cause instanceof Error ? cause.message : "réseau indisponible");
    });
    const contentRange = probe.headers.get("Content-Range");
    const total = contentRange ? Number(contentRange.split("/")[1]) : NaN;
    if (!Number.isFinite(total) || total <= 0) {
      throw new Error("Le serveur ne fournit pas la taille du fichier (Content-Range absent).");
    }
    return HttpByteSource.warmed(url, total);
  }

  /**
   * Starts the two fetches every Matroska file begins with, before anyone asks for them.
   *
   * Reading the header means the front of the file; reading the index means wherever the Cues
   * were written, which for a file made for streaming is the very end. Those two were fetched one
   * after the other, each paying its own round trip, and together they were most of the second
   * that passed between opening a file and knowing what was in it. Asked for together they cost
   * one round trip instead of two.
   *
   * Neither is awaited: a file whose Cues are at the front simply leaves the tail chunk unused,
   * which costs a megabyte and no time at all.
   */
  private static warmed(url: string, size: number): HttpByteSource {
    const source = new HttpByteSource(url, size);
    const last = Math.floor((size - 1) / CHUNK_SIZE);
    for (const index of last > 0 ? [0, last] : [0]) {
      void source.fetchChunk(index).catch(() => {
        // Speculative. The real read will ask again and report properly if it fails.
      });
    }
    return source;
  }

  /**
   * One range, fetched until it arrives or until there is reason to believe it never will.
   *
   * A server that answers 200 to a Range header is not having a bad moment — it does not honour
   * ranges at all, and asking again would only download a forty-gigabyte film four times.
   */
  private async fetchWithRetries(start: number, end: number, own: AbortSignal): Promise<Uint8Array> {
    let last: unknown;
    for (let attempt = 0; attempt < FETCH_ATTEMPTS; attempt++) {
      if (attempt > 0) {
        await waitForNetwork(own);
        await new Promise((resolve) => setTimeout(resolve, FETCH_BACKOFF_MS[attempt - 1] ?? 1500));
        if (this.controller.signal.aborted) throw last ?? new Error("lecture annulée");
        if (own.aborted) throw new ReadAbandoned();
      }
      try {
        const sentAt = performance.now();
        const res = await fetch(this.url, {
          headers: { Range: `bytes=${start}-${end}` },
          // Le signal du lecteur *et* une échéance — voir `readSignal`. L'abandon sur échéance
          // laisse `this.controller.signal.aborted` à faux, si bien que la boucle ci-dessous le
          // traite comme n'importe quel échec réseau : une nouvelle tentative, puis l'écran.
          // Le signal de ce morceau, que la fermeture de la source coupe aussi — voir `abandon`.
          signal: readSignal(own),
        });
        // 206 is the expected answer; a 200 means the server ignored the Range and sent the whole
        // file, which for a 40 GB movie must not be treated as a successful chunk read.
        if (res.status === 200) {
          throw new Error("Le serveur n'honore pas les requêtes de plage (statut 200).");
        }
        if (res.status !== 206) throw new Error(`Le serveur a refusé la plage demandée (statut ${res.status}).`);
        this.checkTotal(res);
        const headersAt = performance.now();
        const bytes = new Uint8Array(await res.arrayBuffer());
        this.note(sentAt, headersAt, performance.now(), bytes.byteLength, res);
        return bytes;
      } catch (error) {
        // Cancelled by the player itself, and a server that ignores ranges: neither improves by
        // being asked again.
        if (this.controller.signal.aborted) throw error;
        // Abandonné pour un saut : ce n'est pas un échec, et le redemander irait contre le saut.
        if (own.aborted) throw new ReadAbandoned();
        if (error instanceof Error && error.message.includes("statut 200")) throw error;
        last = error;
        if (attempt === 0) trace(`réseau : plage ${start}-${end} refusée, nouvelle tentative`);
      }
    }
    throw new NetworkUnavailable(
      last instanceof Error ? `Plage inaccessible : ${last.message}` : "Plage inaccessible."
    );
  }

  private async fetchChunk(index: number): Promise<Uint8Array> {
    const cached = this.chunks.get(index);
    if (cached) return cached;
    const pending = this.inflight.get(index);
    if (pending) return pending;

    const start = index * CHUNK_SIZE;
    const end = Math.min(start + CHUNK_SIZE, this.size) - 1;
    const own = new AbortController();
    this.inflightControllers.set(index, own);
    const promise = this.fetchWithRetries(start, end, own.signal)
      .then((bytes) => {
        // Demandé avant que `checkTotal` ne corrige la taille, un morceau de fin peut avoir été
        // coupé au mauvais endroit : servi à la lecture qui l'attendait, mais pas gardé.
        if (bytes.byteLength === this.expectedLength(index)) {
          this.chunks.set(index, bytes);
          this.evict();
        }
        return bytes;
      })
      .finally(() => {
        this.inflight.delete(index);
        if (this.inflightControllers.get(index) === own) this.inflightControllers.delete(index);
      });

    this.inflight.set(index, promise);
    return promise;
  }

  /**
   * Starts fetching the chunk after the one just used, without waiting for it.
   *
   * Playback reads strictly forward, and a 1 MiB chunk is well under a second of 4K video — so
   * without this, every chunk boundary is a full network round trip the decoder sits through.
   * That stall is what turns a decoder that can keep up into one that visibly cannot.
   */
  private prefetchAfter(index: number): void {
    const depth = performance.now() < this.focusUntil ? SEEK_PREFETCH_CHUNKS : PREFETCH_CHUNKS;
    for (let ahead = 1; ahead <= depth; ahead++) {
      const next = index + ahead;
      if (next * CHUNK_SIZE >= this.size) return;
      if (this.chunks.has(next) || this.inflight.has(next)) continue;
      void this.fetchChunk(next).catch(() => {
        // A failed read-ahead is not an error: the real read will try again and report properly.
      });
    }
  }

  /**
   * Fetches around an offset before anything reads there.
   *
   * A seek knows which cluster it is going to land in the moment the index is consulted, and
   * that is several milliseconds before the parser asks for its first byte. Until now those
   * milliseconds were spent idle and the one after them was spent waiting on a single request:
   * the read-ahead only started once that first chunk had already arrived, so the beginning of
   * every seek was one round trip during which the link carried one megabyte and nothing else —
   * on a file needing four before it can show a picture.
   *
   * Cheap to be wrong about: these are chunks the reader was about to ask for anyway, and a
   * fetch already in flight or already cached is left alone.
   */
  warm(offset: number): void {
    const first = Math.floor(Math.max(0, Math.min(offset, this.size - 1)) / CHUNK_SIZE);
    if (!this.chunks.has(first) && !this.inflight.has(first)) {
      void this.fetchChunk(first).catch(() => {
        // Speculative: the real read asks again and reports properly if it fails.
      });
    }
    this.prefetchAfter(first);
  }

  async read(offset: number, length: number): Promise<Uint8Array> {
    const start = Math.max(0, Math.min(offset, this.size));
    const end = Math.max(start, Math.min(offset + length, this.size));
    if (end === start) return new Uint8Array(0);

    const firstChunk = Math.floor(start / CHUNK_SIZE);
    const lastChunk = Math.floor((end - 1) / CHUNK_SIZE);

    this.lastDemanded = lastChunk;
    // Fast path: the whole read sits inside one chunk, so it's a view, not a copy.
    if (firstChunk === lastChunk) {
      const chunk = await this.fetchChunk(firstChunk);
      this.prefetchAfter(firstChunk);
      const from = start - firstChunk * CHUNK_SIZE;
      return chunk.subarray(from, from + (end - start));
    }

    // Asked for together, not one after the other. Awaiting each in turn made a read spanning
    // four chunks four round trips deep, which is exactly the shape this cache exists to avoid.
    const pending: Promise<Uint8Array>[] = [];
    for (let index = firstChunk; index <= lastChunk; index++) pending.push(this.fetchChunk(index));
    const fetched = await Promise.all(pending);

    const out = new Uint8Array(end - start);
    let written = 0;
    for (let index = firstChunk; index <= lastChunk; index++) {
      const chunk = fetched[index - firstChunk];
      const chunkStart = index * CHUNK_SIZE;
      const from = Math.max(0, start - chunkStart);
      const to = Math.min(chunk.length, end - chunkStart);
      if (to > from) {
        out.set(chunk.subarray(from, to), written);
        written += to - from;
      }
    }
    this.prefetchAfter(lastChunk);
    return written === out.length ? out : out.subarray(0, written);
  }

  /**
   * Un saut vient d'être demandé vers `keepOffset` : tout ce qui est en vol ailleurs est coupé.
   *
   * 22/09/2026, serveur lointain : un saut attendait la fin de la lecture en cours — jusqu'à deux
   * secondes — avant de repositionner le lecteur, et pendant ce temps les six morceaux lus en
   * avance de l'ancienne position occupaient le lien que la nouvelle attendait. On garde ce qui
   * sert le saut lui-même : le morceau où il tombe et l'avance qui le suit.
   */
  abandon(keepOffset: number): void {
    this.focusUntil = performance.now() + SEEK_FOCUS_MS;
    this.window = { since: performance.now(), requests: 0, bytes: 0, lastEnd: 0, fbMin: Infinity, fbMax: 0, slowest: 0, server: null, protocols: {} };
    const first = Math.floor(Math.max(0, Math.min(keepOffset, this.size - 1)) / CHUNK_SIZE);
    let dropped = 0;
    for (const [index, own] of this.inflightControllers) {
      if (index >= first && index <= first + PREFETCH_CHUNKS) continue;
      own.abort();
      this.inflightControllers.delete(index);
      dropped += 1;
    }
    if (dropped > 0) trace(`réseau : ${dropped} lecture(s) de l'ancienne position abandonnée(s)`);
  }

  /** La longueur qu'a le morceau `index` dans un fichier de la taille actuelle. */
  private expectedLength(index: number): number {
    return Math.max(0, Math.min(CHUNK_SIZE, this.total - index * CHUNK_SIZE));
  }

  /**
   * La taille annoncée par la première réponse qui en porte une, comparée à celle de l'ouverture.
   *
   * Une taille connue d'avance vient de la description du fichier, que le lecteur garde en
   * mémoire toute la session : un fichier remplacé entre-temps par son gestionnaire en aurait une
   * autre. Le `Content-Range` d'une plage est la vérité du moment — il arrive avec les premiers
   * octets, avant que le démultiplexeur ait lu quoi que ce soit, et c'est lui qu'on garde. Les
   * morceaux déjà reçus que la nouvelle taille rend faux (un morceau de fin coupé trop tôt) sont
   * oubliés. Tracé, parce qu'un écart dit que la description était périmée. Ne lève jamais.
   */
  private checkTotal(res: Response): void {
    if (this.totalChecked) return;
    try {
      const header = res.headers?.get?.("Content-Range");
      const total = header ? Number(header.split("/")[1]) : NaN;
      if (!Number.isFinite(total) || total <= 0) return;
      this.totalChecked = true;
      if (total === this.total) return;
      trace(`réseau : le serveur annonce ${total} octets, la source était ouverte sur ${this.total} — taille corrigée`);
      this.total = total;
      for (const [index, bytes] of this.chunks) {
        if (bytes.byteLength !== this.expectedLength(index)) this.chunks.delete(index);
      }
    } catch {
      /* une vérification n'est pas une lecture */
    }
  }

  /** Une requête terminée, comptée dans la fenêtre du saut en cours. Ne lève jamais. */
  private note(sentAt: number, headersAt: number, endAt: number, bytes: number, res: Response): void {
    const w = this.window;
    if (!w) return;
    try {
      const serverTiming = res.headers?.get?.("Server-Timing") ?? null;
      w.requests += 1;
      w.bytes += bytes;
      w.lastEnd = Math.max(w.lastEnd, endAt);
      w.fbMin = Math.min(w.fbMin, headersAt - sentAt);
      w.fbMax = Math.max(w.fbMax, headersAt - sentAt);
      w.slowest = Math.max(w.slowest, endAt - sentAt);
      const server = serverTimingApp(serverTiming);
      if (server !== null) w.server = Math.max(w.server ?? 0, server);
      const protocol = protocolOf(this.url);
      if (protocol !== null) w.protocols[protocol] = (w.protocols[protocol] ?? 0) + 1;
    } catch {
      /* une mesure n'est pas une lecture */
    }
  }

  seekSettled(): void {
    if (this.focusUntil === 0) return;
    this.focusUntil = 0;
    if (this.lastDemanded >= 0) this.prefetchAfter(this.lastDemanded);
  }

  networkSinceSeek(): NetworkWindow | null {
    const w = this.window;
    if (!w || w.requests === 0) return null;
    return {
      requests: w.requests,
      bytes: w.bytes,
      elapsedMs: Math.round(w.lastEnd - w.since),
      firstByteMinMs: Math.round(w.fbMin),
      firstByteMaxMs: Math.round(w.fbMax),
      slowestMs: Math.round(w.slowest),
      serverMaxMs: w.server,
      protocols: { ...w.protocols },
    };
  }

  keep(from: number, to: number): void {
    if (!(to > from)) {
      this.kept = null;
      return;
    }
    const first = Math.max(0, Math.floor(from / CHUNK_SIZE));
    const last = Math.min(Math.floor((to - 1) / CHUNK_SIZE), first + MAX_KEPT_CHUNKS - 1);
    this.kept = { first, last };
  }

  /**
   * Le plus ancien d'abord — un démultiplexeur lit presque toujours en avant, donc le plus ancien
   * est d'ordinaire le moins utile —, sauf la zone gardée. Si tout ce qui reste est gardé, le plus
   * ancien part quand même : la borne de mémoire passe avant la préférence.
   */
  private evict(): void {
    while (this.chunks.size > MAX_CACHED_CHUNKS) {
      let victim: number | undefined;
      for (const index of this.chunks.keys()) {
        if (!this.kept || index < this.kept.first || index > this.kept.last) {
          victim = index;
          break;
        }
      }
      victim ??= this.chunks.keys().next().value;
      if (victim === undefined) break;
      this.chunks.delete(victim);
    }
  }

  close(): void {
    this.controller.abort();
    // Chaque morceau a son propre interrupteur : la fermeture les coupe tous.
    for (const own of this.inflightControllers.values()) own.abort();
    this.inflightControllers.clear();
    // Les morceaux arrivés entiers restent valables pour ce fichier : laissés à la source qui le
    // rouvrira, s'il y en a une bientôt. Les requêtes en cours, elles, meurent avec celle-ci.
    leaveHandover(this.url, this.size, this.chunks, this.kept);
    this.chunks = new Map();
    this.inflight.clear();
  }
}
