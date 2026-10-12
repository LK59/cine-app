// « Connexion trop lente » : une cause validée par des mesures, jamais supposée (DECISIONS.md §77).
//
// Le 12/10/2026, un PC sous Edge recevait ~40 Ko/s (≈ 0,3 Mbit/s) derrière la même box qu'un
// iPhone qui avait joué le même épisode vingt-cinq minutes sans une attente (3,9 Mbit/s demandés,
// 143 Mbit/s de lien). Le lecteur natif a renoncé au bout de 35 s (« aucune image », chemin non
// décidé), le lecteur serveur a échoué trois fois sur « pas de première image en 20 s », et la
// spectatrice a lu « Le chargement prend trop de temps. Réessaie. » — vrai, mais sans le pourquoi,
// et le passage au serveur ne pouvait rien : il demandait le même débit au même lien.
//
// Ce module dit si un chargement qui traîne tient au lien, à partir de ce que le lien a réellement
// livré pendant l'attente. Il ne décide qu'au moment où l'un des deux lecteurs allait de toute façon
// renoncer, et seulement quand les trois conditions tiennent ensemble ; sinon il ne dit rien, et
// tout se passe comme avant.
//
// Mesure seulement, sur le chemin même qui va mal : rien ici ne lève (« A check that runs on
// someone else's error path must not become the error », CLAUDE.md).

/**
 * Le motif écrit au journal (`reason` des lignes `fallback` et `error`). Stable : le panneau
 * Activité le reconnaît pour ranger ces séances du côté du réseau, pas du fichier (`seances.ts`).
 */
export const SLOW_LINK_REASON = "connexion trop lente";

/**
 * Le motif de la bascule automatique sur la version allégée à l'ouverture ou après un saut (§78) :
 * le lien en est la cause. Commence par `SLOW_LINK_REASON`, pour que le
 * panneau Activité le range au même endroit (`isSlowLinkReason`).
 */
export const SLOW_LINK_LIGHTER_REASON = `${SLOW_LINK_REASON} (version allégée demandée)`;

/** La bascule sur la version allégée en pleine lecture, sur des saccades (§78). Même préfixe. */
export const SLOW_LINK_STUTTER_REASON = `${SLOW_LINK_REASON} (saccades, version allégée demandée)`;

/** Un motif de journal qui accuse le lien, pas le fichier : le verdict, ou la version allégée demandée. */
export function isSlowLinkReason(reason: string | null | undefined): boolean {
  return typeof reason === "string" && reason.startsWith(SLOW_LINK_REASON);
}

/**
 * Le temps de réception minimal avant de juger : dix secondes pendant lesquelles des octets
 * arrivaient. Assez pour que le démarrage d'une connexion (poignée de main, montée en débit de TCP)
 * et une rafale isolée pèsent peu ; assez court pour tenir dans les deux minuteurs qui décident —
 * 20 s pour le lecteur serveur, 35 s pour le natif.
 */
export const MIN_MEASURED_MS = 10_000;

/**
 * Ce que le lien doit avoir livré pour qu'on parle de lenteur et non de coupure : un quart de
 * morceau du lecteur natif (1 Mio). En dessous, rien ne prouve qu'il livre quoi que ce soit — et une
 * coupure a déjà son écran, « connexion perdue », qui attend le réseau au lieu de renoncer.
 */
export const MIN_RECEIVED_BYTES = 256 * 1024;

/**
 * « Nettement sous le besoin » : moins de la moitié du débit moyen du fichier. Un lien à 80 % du
 * besoin ouvre lentement puis attend de temps en temps ; à moins de 50 %, il faut deux secondes de
 * réseau pour chaque seconde de film, et aucune attente raisonnable ne mène à une image. La marge
 * absorbe aussi ce qu'une moyenne cache — un passage plus lourd que le reste, les en-têtes.
 */
export const SLOW_SHARE = 0.5;

/** Une connexion lente, validée : les chiffres qui l'ont décidée partent avec elle. */
export interface SlowLink {
  /** Ce que le lien a livré pendant qu'il livrait, en bits par seconde. */
  recvBps: number;
  /** Ce que le flux demande en moyenne, en bits par seconde. */
  needBps: number;
  /** La durée de réception mesurée, en millisecondes. */
  measuredMs: number;
  /** Les octets reçus pendant cette durée. */
  bytes: number;
}

/** Ce qu'un compteur a vu : octets reçus, et l'union des instants où des octets pouvaient arriver. */
export interface LinkMeasure {
  bytes: number;
  receivingMs: number;
}

/**
 * Le verdict. `null` veut dire « rien de prouvé » — l'appelant garde alors exactement son
 * comportement d'avant. Le débit est pris sur le temps de *réception* (des en-têtes au dernier
 * octet), pas sur l'horloge murale : l'attente d'un serveur qui prépare sa réponse (un transcodage
 * qui démarre, un disque qui se réveille) n'est pas la faute du lien, et le débit qu'on en tire
 * est le plus favorable au lien — l'erreur, s'il y en a une, va du côté de l'ancien comportement.
 */
export function slowLinkVerdict(measure: LinkMeasure | null | undefined, needBps: number | null | undefined): SlowLink | null {
  try {
    if (!measure || typeof needBps !== "number" || !Number.isFinite(needBps) || needBps <= 0) return null;
    const { bytes, receivingMs } = measure;
    if (!Number.isFinite(bytes) || !Number.isFinite(receivingMs)) return null;
    if (receivingMs < MIN_MEASURED_MS) return null;
    if (bytes < MIN_RECEIVED_BYTES) return null;
    const recvBps = (bytes * 8) / (receivingMs / 1000);
    if (!(recvBps < SLOW_SHARE * needBps)) return null;
    return { recvBps, needBps, measuredMs: receivingMs, bytes };
  } catch {
    return null;
  }
}

// --- pendant l'ouverture : les seuils de l'indice et de la bascule (décidées dans slowLinkPolicy.ts) ---

/**
 * Le temps de réception avant de *dire* qu'un lien semble lent (l'indice « Connexion lente… » sous
 * la ligne de chargement) : cinq secondes. Assez pour que la poignée de main et la montée en débit
 * de TCP pèsent peu ; assez tôt pour que la spectatrice lise la cause pendant qu'elle attend, au lieu
 * de la découvrir au bout de 35 s. Un indice n'arrête rien : il se retire de lui-même si le débit
 * remonte, et un faux positif ne coûte qu'un mot affiché quelques secondes.
 */
export const HINT_MEASURED_MS = 5_000;

/**
 * « Très en dessous du besoin » : moins du quart du débit moyen du fichier — quatre secondes de réseau
 * pour chaque seconde de film. Avec les preuves du verdict (10 s de réception, 256 Kio), l'ouverture
 * bascule sur la version allégée dès 10 s (`openingAdvice`, slowLinkPolicy.ts, DECISIONS.md §78). Le cas
 * réel du 12/10/2026 (Edge d'Augustine : ≈ 0,3 Mbit/s reçus pour 3,9 demandés) est sous 10 % dès dix
 * secondes : la marge jusqu'à 25 % est large. Entre 25 % et 50 %, la bascule attend 20 s sans image.
 */
export const NOTICE_SHARE = 0.25;

/** Les champs de la ligne de journal : chiffres arrondis, lisibles avec `jq`. */
export function slowLinkFields(slow: SlowLink): Record<string, number> {
  return {
    recvMbps: Math.round((slow.recvBps / 1e6) * 100) / 100,
    needMbps: Math.round((slow.needBps / 1e6) * 10) / 10,
    measuredS: Math.round(slow.measuredMs / 100) / 10,
    bytes: Math.round(slow.bytes),
  };
}

// --- le compteur ---------------------------------------------------------------------------------

/** Une requête suivie : quand ses en-têtes sont arrivés, quand elle a fini, ce qu'elle a livré. */
export interface MeteredRequest {
  /** Les en-têtes sont là : à partir d'ici, des octets peuvent arriver. */
  headers(): void;
  /** Des octets sont arrivés. */
  received(bytes: number): void;
  /** Finie — reçue, échouée ou abandonnée. Rien de plus ne compte. */
  end(): void;
}

interface Tracked {
  headersAt: number | null;
  endAt: number | null;
}

/**
 * Ce que le lien livre, requête par requête — octets au fil de l'eau et instants de réception.
 *
 * L'horloge est `Date.now` (injectable) : c'est elle que les minuteurs des lecteurs suivent, et
 * celle que les tests savent avancer.
 */
export class LinkMeter {
  private readonly requests: Tracked[] = [];
  private bytes = 0;
  /** Les arrivées récentes (instant, octets), pour un débit sur quelques secondes — bornées. */
  private readonly arrivals: [number, number][] = [];

  constructor(private readonly clock: () => number = () => Date.now()) {}

  open(): MeteredRequest {
    const tracked: Tracked = { headersAt: null, endAt: null };
    try {
      // Borné : une ouverture fait quelques dizaines de requêtes ; au-delà, les plus vieilles sortent.
      if (this.requests.length >= 400) this.requests.splice(0, 200);
      this.requests.push(tracked);
    } catch {
      /* une mesure n'est pas une lecture */
    }
    return {
      headers: () => {
        try {
          if (tracked.headersAt === null && tracked.endAt === null) tracked.headersAt = this.clock();
        } catch {
          /* rien */
        }
      },
      received: (bytes: number) => {
        try {
          if (tracked.endAt !== null || !(bytes > 0)) return;
          const at = this.clock();
          if (tracked.headersAt === null) tracked.headersAt = at;
          this.bytes += bytes;
          this.arrivals.push([at, bytes]);
          if (this.arrivals.length > 4000) this.arrivals.splice(0, 2000);
        } catch {
          /* rien */
        }
      },
      end: () => {
        try {
          if (tracked.endAt === null) tracked.endAt = this.clock();
        } catch {
          /* rien */
        }
      },
    };
  }

  /**
   * Ce que le lien a livré pendant les `windowMs` dernières millisecondes : les octets arrivés dans la
   * fenêtre, et l'union des intervalles de réception qui y tombent. Pour la lecture du lecteur serveur
   * (hls.js compte ses octets au fil de l'eau) : le débit *récent*, que la moyenne de toute la séance
   * noierait après une heure de film.
   */
  recentMeasure(windowMs: number): LinkMeasure {
    try {
      const at = this.clock();
      const from = at - windowMs;
      let bytes = 0;
      for (let i = this.arrivals.length - 1; i >= 0 && this.arrivals[i][0] > from; i--) bytes += this.arrivals[i][1];
      const spans = this.requests
        .filter((r) => r.headersAt !== null)
        .map((r) => [Math.max(r.headersAt as number, from), r.endAt ?? at] as const)
        .filter(([a, b]) => b > a)
        .sort((x, y) => x[0] - y[0]);
      let receivingMs = 0;
      let end = -Infinity;
      for (const [a, b] of spans) {
        if (b <= end) continue;
        receivingMs += b - Math.max(a, end);
        end = b;
      }
      return { bytes, receivingMs };
    } catch {
      return { bytes: 0, receivingMs: 0 };
    }
  }

  /** Les Mb/s arrivés sur les `ms` dernières millisecondes (horloge murale) — pour la chronologie. */
  recentMbps(ms: number): number | null {
    try {
      const from = this.clock() - ms;
      let bytes = 0;
      for (let i = this.arrivals.length - 1; i >= 0 && this.arrivals[i][0] > from; i--) bytes += this.arrivals[i][1];
      return ms > 0 ? Math.round(((bytes * 8) / (ms / 1000) / 1e6) * 10) / 10 : null;
    } catch {
      return null;
    }
  }

  /**
   * Ce qui a été reçu, et l'union des intervalles de réception — chaque instant une fois, quel que
   * soit le nombre de requêtes en vol en même temps : six requêtes parallèles partagent un lien,
   * elles ne le multiplient pas.
   */
  measure(): LinkMeasure {
    try {
      const at = this.clock();
      const spans = this.requests
        .filter((r) => r.headersAt !== null)
        .map((r) => [r.headersAt as number, r.endAt ?? at] as const)
        .filter(([a, b]) => b > a)
        .sort((x, y) => x[0] - y[0]);
      let receivingMs = 0;
      let end = -Infinity;
      for (const [a, b] of spans) {
        if (b <= end) continue;
        receivingMs += b - Math.max(a, end);
        end = b;
      }
      return { bytes: this.bytes, receivingMs };
    } catch {
      return { bytes: 0, receivingMs: 0 };
    }
  }
}

// --- le compteur de l'ouverture du lecteur natif -------------------------------------------------

/**
 * Le compteur de l'ouverture en cours du lecteur natif, armé par l'hôte tant qu'aucune image n'est
 * prête et lu par `HttpByteSource` à chaque requête. Global, comme `playbackDiagnosis` : un lecteur
 * natif à la fois. Désarmé, il n'existe pas, et `HttpByteSource` lit ses réponses exactement comme
 * avant — une lecture en cours de film ne passe jamais par ici.
 */
let openingMeter: LinkMeter | null = null;

export function armOpeningMeter(clock?: () => number): LinkMeter {
  const meter = new LinkMeter(clock);
  openingMeter = meter;
  return meter;
}

export function disarmOpeningMeter(meter: LinkMeter): void {
  if (openingMeter === meter) openingMeter = null;
}

/** La requête qui part, suivie si une ouverture est en cours ; `null` sinon. */
export function meterOpeningRequest(): MeteredRequest | null {
  try {
    return openingMeter?.open() ?? null;
  } catch {
    return null;
  }
}

/**
 * NON BRANCHÉE (12/10/2026) : `HttpByteSource` lit d'un bloc et compte le morceau une fois arrivé.
 * Gardée pour le jour où le lecteur natif aura besoin du débit au fil de l'eau (qualité adaptée au
 * réseau, traitement progressif des octets) — à valider alors sur les vrais moteurs (WebKit iOS
 * surtout : annulation, erreurs en plein corps, mémoire) avant de la brancher. Voir DECISIONS §77.
 *
 * Lit un corps de réponse en comptant ce qui arrive — les mêmes octets qu'`arrayBuffer()`, dans le
 * même ordre. Un corps sans lecteur de flux (navigateur ancien, double de test) est lu d'un bloc :
 * on perd la mesure, pas la lecture.
 */
export async function readCounted(res: Response, metered: MeteredRequest): Promise<Uint8Array> {
  const body = res.body;
  if (!body || typeof body.getReader !== "function") {
    const whole = new Uint8Array(await res.arrayBuffer());
    metered.received(whole.byteLength);
    return whole;
  }
  const reader = body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    parts.push(value);
    total += value.byteLength;
    metered.received(value.byteLength);
  }
  // Toujours recopié, même en un seul morceau : `arrayBuffer()` rend un tampon à soi, commençant à
  // zéro et de la taille exacte, et ce qui suit peut lire `.buffer` (voir `exactBytes`).
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

// --- ce que le lecteur serveur en retient ---------------------------------------------------------

/** Le débit moyen d'un fichier, d'après son poids et sa durée — ce que le lecteur natif doit tenir. */
export function fileNeedBps(sizeBytes: number | null | undefined, seconds: number | null | undefined): number | null {
  if (typeof sizeBytes !== "number" || typeof seconds !== "number") return null;
  if (!(sizeBytes > 0) || !(seconds > 0) || !Number.isFinite(sizeBytes) || !Number.isFinite(seconds)) return null;
  return (sizeBytes * 8) / seconds;
}

/**
 * Suit une requête d'hls.js (lecteur serveur), par son `xhrSetup` : en-têtes, octets au fil de
 * l'eau (`progress` donne le cumul), fin. Des écouteurs ajoutés, jamais remplacés — hls.js pose
 * ses propres `onprogress` et `onreadystatechange`, que rien ici ne touche.
 */
export function meterXhr(meter: LinkMeter, xhr: XMLHttpRequest): void {
  try {
    const request = meter.open();
    let counted = 0;
    const progress = (event: ProgressEvent) => {
      const loaded = Number(event?.loaded);
      if (Number.isFinite(loaded) && loaded > counted) {
        request.received(loaded - counted);
        counted = loaded;
      }
    };
    xhr.addEventListener("readystatechange", () => {
      if (xhr.readyState >= 2) request.headers();
    });
    xhr.addEventListener("progress", progress);
    xhr.addEventListener("loadend", (event) => {
      progress(event);
      request.end();
    });
  } catch {
    /* une mesure n'est pas une lecture */
  }
}

/** Le débit que le lecteur serveur reçoit de Jellyfin : vidéo et son du flux négocié. */
export function streamNeedBps(info: { video?: { bitRate: number | null } | null; audio?: { bitRate: number | null } | null } | null | undefined): number | null {
  const video = info?.video?.bitRate;
  if (typeof video !== "number" || !(video > 0)) return null;
  const audio = info?.audio?.bitRate;
  return video + (typeof audio === "number" && audio > 0 ? audio : 0);
}

// --- ce que le panneau technique et les bilans en montrent --------------------------------------

/**
 * L'état du lien tel que le panneau d'infos techniques le montre : le débit réellement reçu (pendant
 * la réception), le besoin du flux, et le verdict par le même critère que l'abandon — « trop lente »
 * ne s'affiche que là où il se serait écrit au journal. `frozen` : la lecture prise au moment d'un
 * échec, qui ne bouge plus.
 */
export interface LinkReading {
  recvBps: number | null;
  needBps: number | null;
  verdict: "ok" | "slow" | "unknown";
  frozen: boolean;
  /** Le palier de version allégée en cours (§78) : débit demandé à Jellyfin et rang. */
  lighter?: { targetBps: number; tier: number } | null;
}

/** Le verdict d'une mesure en cours. « ok » demande autant de preuves que « trop lente ». */
export function readLink(measure: LinkMeasure | null | undefined, needBps: number | null | undefined): LinkReading {
  try {
    const need = typeof needBps === "number" && needBps > 0 && Number.isFinite(needBps) ? needBps : null;
    if (!measure || !(measure.receivingMs > 0)) return { recvBps: null, needBps: need, verdict: "unknown", frozen: false };
    const recvBps = (measure.bytes * 8) / (measure.receivingMs / 1000);
    const enough = measure.receivingMs >= MIN_MEASURED_MS && measure.bytes >= MIN_RECEIVED_BYTES;
    const verdict = need === null || !enough ? "unknown" : slowLinkVerdict(measure, need) ? "slow" : "ok";
    return { recvBps: Number.isFinite(recvBps) ? recvBps : null, needBps: need, verdict, frozen: false };
  } catch {
    return { recvBps: null, needBps: null, verdict: "unknown", frozen: false };
  }
}

/** La lecture figée d'une connexion trop lente validée — celle qui a décidé. */
export function frozenReading(slow: SlowLink): LinkReading {
  return { recvBps: slow.recvBps, needBps: slow.needBps, verdict: "slow", frozen: true };
}

/** Le mot du journal pour un verdict (`diag.linkVerdict`) : lisible avec `jq`, stable. */
export function linkVerdictWord(reading: LinkReading): "suffisante" | "trop lente" | "inconnue" {
  return reading.verdict === "ok" ? "suffisante" : reading.verdict === "slow" ? "trop lente" : "inconnue";
}
