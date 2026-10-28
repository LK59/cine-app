/**
 * Le lecteur de livres dans un cadre posé sur le cinéma (DECISIONS.md §127, « Les transitions », et §128).
 *
 * Le lecteur ne vit que sous la politique de sécurité de `/livres` (cadres `blob:` des chapitres). Ouvert
 * depuis le cinéma, il y allait par un vrai chargement de page, et le refermer rechargeait tout le cinéma
 * (~0,5 s, l'accueil reconstruit sous les yeux). Il s'ouvre maintenant dans un `<iframe>` de la même
 * origine posé par-dessus : c'est toujours le document `/livres`, avec sa politique et ses trois barrières,
 * et le refermer retire le cadre — le cinéma dessous n'a pas bougé.
 *
 * Ce module est le contrat entre les deux documents, et rien d'autre : l'adresse du cadre, les messages
 * et leur vérification. Le cadre ne touche jamais à l'historique de la fenêtre du dessus (une entrée
 * poussée dans un cadre s'empile dans l'historique commun : Retour reculerait dans le cadre) ; il dit
 * au cinéma ce qui se passe, et le cinéma décide — `cinemaClose`, un seul retour en vol.
 *
 * Les messages sont des objets aux clés exactes, vérifiés des deux côtés : l'origine est la nôtre, et la
 * source est la fenêtre attendue (le cadre pour le cinéma, le cinéma pour le cadre). Un chapitre de livre
 * n'exécute rien (pas d'`allow-scripts`, contenu nettoyé, politique de la page) ; ces vérifications sont
 * une ceinture de plus, pas une barrière dont la sécurité dépendrait.
 */

/** Le paramètre qui dit à la page des livres qu'elle est le lecteur posé sur le cinéma. */
export const READER_FRAME_PARAM = "cadre";
/** Côté cinéma : une position a été lue — la grille ouverte par-dessus l'accueil relit ses pages. */
export const BOOKS_PROGRESS_EVENT = "laterna:books:progress";
const APP = "laterna-livres";
const VERSION = 1;
const BOOK_ID = /^[0-9a-f]{32}$/;

/** L'adresse du cadre : la page des livres, ouverte pour lire ce livre. */
export function readerFrameUrl(id: string): string {
  return `/livres?${READER_FRAME_PARAM}=1#livre=${id}&lire=1`;
}

/** Du cadre au cinéma : `hello` (le cadre écoute), `ready` (première page ou erreur affichée), `saved` (une position est enregistrée), `close`. */
export type FrameKind = "hello" | "ready" | "saved" | "close";
export interface FrameMessage {
  app: typeof APP;
  v: typeof VERSION;
  kind: FrameKind;
  book: string;
}

/** Du cinéma au cadre : les marges de l'écran (encoche, barre d'accueil), qu'un cadre ne reçoit pas. */
export interface Insets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}
export interface ParentMessage extends Insets {
  app: typeof APP;
  v: typeof VERSION;
  kind: "insets";
}

const FRAME_KINDS: readonly FrameKind[] = ["hello", "ready", "saved", "close"];
const MAX_INSET = 400;

function exactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  if (Object.getPrototypeOf(value) !== Object.prototype) return false;
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((k) => Object.prototype.hasOwnProperty.call(value, k));
}

export function frameMessage(kind: FrameKind, book: string): FrameMessage {
  return { app: APP, v: VERSION, kind, book };
}

export function parentMessage(insets: Insets): ParentMessage {
  return { app: APP, v: VERSION, kind: "insets", top: insets.top, right: insets.right, bottom: insets.bottom, left: insets.left };
}

/** Un message du cadre, ou `null` s'il n'en a pas exactement la forme. */
export function parseFrameMessage(data: unknown): FrameMessage | null {
  if (!exactKeys(data, ["app", "v", "kind", "book"])) return null;
  if (data.app !== APP || data.v !== VERSION) return null;
  if (typeof data.kind !== "string" || !FRAME_KINDS.includes(data.kind as FrameKind)) return null;
  if (typeof data.book !== "string" || !BOOK_ID.test(data.book)) return null;
  return { app: APP, v: VERSION, kind: data.kind as FrameKind, book: data.book };
}

/** Un message du cinéma, ou `null`. */
export function parseParentMessage(data: unknown): ParentMessage | null {
  if (!exactKeys(data, ["app", "v", "kind", "top", "right", "bottom", "left"])) return null;
  if (data.app !== APP || data.v !== VERSION || data.kind !== "insets") return null;
  const sides = [data.top, data.right, data.bottom, data.left];
  if (!sides.every((n) => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= MAX_INSET)) return null;
  return parentMessage({ top: data.top as number, right: data.right as number, bottom: data.bottom as number, left: data.left as number });
}

/**
 * Côté cinéma : le message vient-il du cadre du lecteur ? Notre origine, la fenêtre de ce cadre-là, et
 * la forme exacte — sinon `null`, sans rien lire de plus.
 */
export function acceptFromFrame(event: Pick<MessageEvent, "origin" | "source" | "data">, frame: Window | null, origin: string): FrameMessage | null {
  if (!frame || event.origin !== origin || event.source !== frame) return null;
  return parseFrameMessage(event.data);
}

/** Côté cadre : le message vient-il du cinéma qui l'a posé ? */
export function acceptFromParent(event: Pick<MessageEvent, "origin" | "source" | "data">, parent: Window | null, origin: string): ParentMessage | null {
  if (!parent || event.origin !== origin || event.source !== parent) return null;
  return parseParentMessage(event.data);
}

/**
 * La page des livres est-elle le lecteur posé sur le cinéma ? Le paramètre ne suffit pas (une adresse
 * gardée, recopiée) : il faut aussi un parent, et de notre origine. Sinon, la page se comporte comme
 * avant — ouverte seule, un lien direct, un rechargement, la page hors ligne.
 */
export function isFramedReader(): boolean {
  if (typeof window === "undefined") return false;
  try {
    if (new URLSearchParams(window.location.search).get(READER_FRAME_PARAM) !== "1") return false;
    if (window.parent === window) return false;
    // Lire l'origine d'un parent d'une autre origine lève : c'est la réponse.
    return window.parent.location.origin === window.location.origin;
  } catch {
    return false;
  }
}

/** Côté cadre : dire au cinéma. Rien ne part hors de notre origine (`targetOrigin`). */
export function tellCinema(kind: FrameKind, book: string): void {
  try {
    window.parent.postMessage(frameMessage(kind, book), window.location.origin);
  } catch {
    /* plus de parent : le cadre est en train d'être retiré */
  }
}

/** Les marges d'un côté, en CSS : celles du cadre s'il en reçoit, sinon celles que le cinéma a mesurées. */
export function insetVar(side: keyof Insets): string {
  return `var(--reader-inset-${side}, env(safe-area-inset-${side}))`;
}

export function insetValue(px: number, side: keyof Insets): string {
  return `max(env(safe-area-inset-${side}), ${Math.round(px)}px)`;
}
