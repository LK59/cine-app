import { MOVIES_CATALOGUE_KEY, SERIES_CATALOGUE_KEY } from "@/lib/catalogueKeys";

/**
 * Le catalogue relu au retour au premier plan — sans un octet ni un rendu de trop (15/10/2026,
 * DECISIONS.md §94).
 *
 * Le catalogue était figé une fois chargé : redemandé au lancement, à la reconnexion, et nulle part
 * ailleurs. Une PWA d'iPhone ne se relance presque jamais — elle revient au premier plan —, si bien
 * qu'un film supprimé de Radarr le matin restait affiché le soir, et qu'un film arrivé dans la
 * journée n'apparaissait qu'au redémarrage du téléphone.
 *
 * Ce module tient, pour chacun des deux catalogues, **ce qui a été lu du réseau** : son étiquette
 * (`ETag`), quand, l'objet rendu à SWR, et le dernier catalogue « vrai » (non marqué par une panne,
 * §92). Trois décisions en découlent, et chacune n'est prise qu'ici :
 *
 *  - **faut-il relire ?** — `catalogueRefreshDue` : la dernière lecture réussie a plus de
 *    `CATALOGUE_REFRESH_AFTER_MS` ;
 *  - **la réponse est-elle neuve ?** — une étiquette inchangée rend l'objet déjà tenu, jamais un
 *    objet neuf : SWR ne voit rien changer, l'écran ne se redessine pas (le défaut du 29/09/2026 :
 *    une réponse identique, objet neuf, redessinait toute la grille — voir `cacheOnlyOptions`) ;
 *  - **une copie de secours peut-elle remplacer ce qu'on tient ?** — `reconcileCatalogue` : non,
 *    quand ce qu'on tient est plus récent qu'elle ; elle n'apporte alors que ses marques (le bandeau
 *    et le refus de lecture de §92), les titres restent ceux qu'on avait.
 *
 * La relecture elle-même (`refreshCatalogues`) envoie l'étiquette en `If-None-Match` : le serveur
 * répond 304 sans corps quand rien n'a changé (`respondPrepared`). Écrite à la main plutôt que
 * laissée au cache HTTP du navigateur : avec un en-tête conditionnel posé par la page, `fetch` ne
 * consulte pas son cache et rend le 304 tel quel — pas de corps relu, pas de JSON analysé, rien à
 * comparer. Le cache HTTP, lui, rendait un 200 reconstitué que la page ne savait pas distinguer d'une
 * réponse neuve.
 */

/** Au-delà, un retour au premier plan relit les catalogues. */
export const CATALOGUE_REFRESH_AFTER_MS = 15 * 60_000;

/** Les deux clés relues, dans l'ordre où elles le sont — une requête à la fois. */
export const REFRESHED_CATALOGUE_KEYS: readonly string[] = [MOVIES_CATALOGUE_KEY, SERIES_CATALOGUE_KEY];

export function isCatalogueKey(key: string): boolean {
  return REFRESHED_CATALOGUE_KEYS.includes(key);
}

/** Les marques d'une réponse servie pendant une panne (`CatalogueOutageFlags`, §92). */
interface Marks {
  stale?: unknown;
  jellyfinDown?: unknown;
  savedAt?: unknown;
}

interface ReadState {
  /** L'étiquette de la dernière réponse lue du réseau (200), `null` si le serveur n'en donne pas. */
  etag: string | null;
  /** Quand la dernière lecture a réussi, 304 compris (horloge de l'appareil). */
  readAt: number;
  /** L'objet rendu à SWR pour cette lecture. */
  held: object;
  /** Le dernier catalogue non périmé lu — ses titres, quand une copie de secours plus ancienne arrive. */
  fresh: object | null;
  /** L'heure du serveur à laquelle `fresh` a été servi (en-tête `Date`, fin de sa seconde). */
  freshServerAt: number | null;
  /** Change à chaque lecture : une relecture qui a vu une autre lecture aboutir pendant son vol s'efface. */
  seq: number;
}

const reads = new Map<string, ReadState>();
let seq = 0;

/** Pour les tests. */
export function resetCatalogueRefreshForTests(): void {
  reads.clear();
  inFlight = null;
}

function stale(data: unknown): boolean {
  return !!data && typeof data === "object" && (data as Marks).stale === true;
}

/** Les titres d'un catalogue, sans aucune marque de panne. */
function withoutMarks(data: object): Record<string, unknown> {
  // Les trois marques écartées, le reste gardé.
  const { stale: _s, jellyfinDown: _j, savedAt: _a, ...titles } = data as Record<string, unknown> & Marks;
  return titles;
}

/**
 * L'objet à tenir quand `incoming` arrive : `incoming` lui-même, sauf une copie de secours (§92,
 * `stale`) plus ancienne que le dernier vrai catalogue lu — ses titres restent alors ceux de ce
 * catalogue, et seules ses marques passent. Ce que le serveur garde est « le dernier catalogue servi
 * à ce compte », écrit quand il change (`savedAt`) : une copie gardée avant notre dernière lecture n'a
 * rien de plus récent à dire, et la laisser remplacer nos titres ferait revenir un film retiré depuis
 * (ou repartir un film arrivé). Une copie gardée *après* — un autre appareil du compte a lu un
 * catalogue plus neuf — passe telle quelle.
 *
 * `previous` : l'objet tenu jusqu'ici, rendu tel quel quand il porte déjà ces titres et ces marques
 * — la relecture de 30 s de la panne ne redessine rien tant que rien ne change.
 */
export function reconcileCatalogue(
  incoming: object,
  fresh: object | null,
  freshServerAt: number | null,
  previous: object | null
): object {
  if (!stale(incoming)) return incoming;
  const savedAt = (incoming as Marks).savedAt;
  if (!fresh || freshServerAt === null || typeof savedAt !== "number" || savedAt > freshServerAt) return incoming;
  const marks = incoming as Marks;
  if (
    previous &&
    stale(previous) &&
    (previous as Marks).jellyfinDown === marks.jellyfinDown &&
    Object.keys(withoutMarks(fresh)).every((key) => (previous as Record<string, unknown>)[key] === (fresh as Record<string, unknown>)[key])
  ) {
    return previous;
  }
  return {
    ...withoutMarks(fresh),
    stale: true,
    ...(marks.jellyfinDown === true ? { jellyfinDown: true } : {}),
    savedAt,
  };
}

/** Un en-tête, gardé : une réponse simulée (tests, préchargement) n'en a pas toujours. */
function headerOf(res: Response, name: string): string | null {
  try {
    return res.headers?.get(name) ?? null;
  } catch {
    return null;
  }
}

/** L'heure du serveur d'une réponse : la fin de la seconde de son en-tête `Date` (à défaut, celle de l'appareil). */
function serverTimeOf(res: Response, now: number): number {
  const header = headerOf(res, "date");
  const parsed = header ? Date.parse(header) : Number.NaN;
  return Number.isFinite(parsed) ? parsed + 999 : now;
}

/**
 * Une réponse identique à la dernière lue (même étiquette) : l'objet déjà tenu, sans relire le corps.
 * Note la lecture. `undefined` quand il faut lire le corps.
 *
 * Vaut aussi pour la lecture ordinaire de SWR (`cinemaFetcher`), où le cache HTTP du navigateur rend
 * un 200 reconstitué après un 304 : sans ceci, un mégaoctet et demi de JSON analysé, hydraté, puis
 * comparé champ à champ par SWR, pour conclure que rien n'a changé.
 */
export function catalogueUnchanged(key: string, res: Response, now = Date.now()): object | undefined {
  if (!isCatalogueKey(key)) return undefined;
  const state = reads.get(key);
  const etag = headerOf(res, "etag");
  if (!state || !etag || state.etag !== etag) return undefined;
  state.readAt = now;
  return state.held;
}

/**
 * Une réponse lue (200) : note son étiquette et son heure, et rend l'objet à donner à SWR — `data`,
 * ou les titres tenus sous les marques d'une copie de secours plus ancienne (`reconcileCatalogue`).
 */
export function noteCatalogueRead<T>(key: string, res: Response, data: T, now = Date.now()): T {
  if (!isCatalogueKey(key) || !data || typeof data !== "object") return data;
  const state = reads.get(key);
  const held = reconcileCatalogue(data, state?.fresh ?? null, state?.freshServerAt ?? null, state?.held ?? null);
  const isFresh = !stale(data);
  reads.set(key, {
    etag: headerOf(res, "etag"),
    readAt: now,
    held,
    fresh: isFresh ? data : state?.fresh ?? null,
    freshServerAt: isFresh ? serverTimeOf(res, now) : state?.freshServerAt ?? null,
    seq: ++seq,
  });
  return held as T;
}

/**
 * Faut-il relire ce catalogue ? Seulement s'il a déjà été lu du réseau sur cette page, et pas depuis
 * `CATALOGUE_REFRESH_AFTER_MS`. Jamais lu : la lecture du lancement est en vol, ou a échoué — SWR
 * la reprend à la reconnexion et sur ses erreurs, ce n'est pas l'affaire du retour au premier plan.
 */
export function catalogueRefreshDue(key: string, now = Date.now()): boolean {
  const state = reads.get(key);
  return state !== undefined && now - state.readAt >= CATALOGUE_REFRESH_AFTER_MS;
}

/** Ce que la relecture demande à l'écran — injecté, pour que le module reste sans React. */
export interface RefreshIo {
  /** Les clés à relire maintenant (tenues par l'écran, dues, sans requête de SWR en vol). */
  keys: readonly string[];
  /** La donnée que SWR tient pour cette clé. */
  heldNow(key: string): unknown;
  /** Pose une donnée neuve dans SWR, sans relecture (`mutate(key, data, { revalidate: false })`). */
  apply(key: string, data: unknown): void;
  /** Rien n'interdit-il de poser maintenant ? (page visible, aucun film, aucun écran qui la tient) */
  canApply(): boolean;
  /** Attend que l'interface soit au repos avant de lire le corps — `whenUiQuiet`. */
  whenQuiet(): Promise<void>;
  /** Une 304 : la donnée tenue est toujours la bonne — l'appareil la redate (`persistentCache`). */
  unchanged?(key: string, data: unknown): void;
  /** Lecture d'un corps de catalogue en forme d'écran (`hydrateCatalogue`). */
  read(key: string, res: Response): Promise<unknown>;
  fetch?: typeof fetch;
}

export type RefreshOutcome = "unchanged" | "applied" | "failed" | "dropped" | "superseded";

let inFlight: Promise<RefreshOutcome[]> | null = null;

/** Une relecture est-elle en vol ? */
export function catalogueRefreshInFlight(): boolean {
  return inFlight !== null;
}

async function refreshOne(key: string, io: RefreshIo): Promise<RefreshOutcome> {
  const state = reads.get(key);
  if (!state) return "dropped";
  const startedSeq = state.seq;
  const doFetch = io.fetch ?? fetch;
  let res: Response;
  try {
    res = await doFetch(key, state.etag ? { headers: { "If-None-Match": state.etag } } : undefined);
  } catch {
    // Hors ligne : rien ne change, et le prochain retour réessaiera (la lecture n'est pas datée).
    return "failed";
  }
  if (res.status === 304) {
    const current = reads.get(key);
    if (current) current.readAt = Date.now();
    io.unchanged?.(key, current?.held);
    return "unchanged";
  }
  if (!res.ok) return "failed";
  // Même étiquette en 200 (un intermédiaire qui ignore la condition) : rien à lire.
  const same = catalogueUnchanged(key, res);
  if (same !== undefined) {
    io.unchanged?.(key, same);
    return "unchanged";
  }
  // Un catalogue neuf se lit d'un bloc : pas sous un geste (`uiQuiet.ts`).
  await io.whenQuiet();
  if (!io.canApply()) return "dropped";
  if (reads.get(key)?.seq !== startedSeq) return "superseded";
  let data: unknown;
  try {
    data = await io.read(key, res);
  } catch {
    return "failed";
  }
  // Relu pendant l'analyse : la lecture qui a abouti entre-temps fait foi.
  if (reads.get(key)?.seq !== startedSeq || !io.canApply()) return "superseded";
  const held = noteCatalogueRead(key, res, data);
  if (held === io.heldNow(key)) return "unchanged";
  io.apply(key, held);
  return "applied";
}

/**
 * Relit les catalogues dus, l'un après l'autre. Une seule relecture à la fois : un second appel
 * pendant qu'elle court (le focus et `visibilitychange` arrivent ensemble sur ordinateur) rend la
 * même promesse.
 */
export function refreshCatalogues(io: RefreshIo): Promise<RefreshOutcome[]> {
  if (inFlight) return inFlight;
  const run = (async () => {
    const outcomes: RefreshOutcome[] = [];
    for (const key of io.keys) {
      if (!io.canApply()) {
        outcomes.push("dropped");
        continue;
      }
      outcomes.push(await refreshOne(key, io));
    }
    return outcomes;
  })();
  inFlight = run;
  void run.finally(() => {
    if (inFlight === run) inFlight = null;
  });
  return run;
}
