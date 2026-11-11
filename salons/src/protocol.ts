import { parseGameData, type QuizGameData, type QuizView } from "./quiz.ts";
import { parseLook, type Look, type TvView } from "./tv.ts";

/**
 * Le protocole des salons : ce qu'un client peut dire, ce que le service répond, et les bornes.
 *
 * Des messages JSON courts sur une WebSocket, chacun avec un type `t`. Le service est **l'autorité** : un client
 * envoie une intention (« allumer les lampes du salon »), le service la vérifie, l'applique, la numérote et la
 * diffuse à tout le salon — le demandeur compris, qui ne l'applique qu'à son retour. Personne ne diverge.
 *
 * Tout ce qui entre est vérifié ici, champ par champ : un message inconnu, trop gros ou mal formé est refusé
 * avec une erreur nommée, jamais à moitié appliqué.
 */

export const LIMITS = {
  /** Octets d'un message (la WebSocket refuse au-delà, avant même de le lire). */
  maxMessageBytes: 4096,
  /** Personnes dans un salon. */
  maxMembers: 8,
  /** Salons ouverts en même temps sur le service. */
  maxRooms: 64,
  /** Longueur du nom d'un salon. */
  maxRoomName: 40,
  /** Débit par connexion : un seau de 60 messages qui se remplit de 30 par seconde. */
  bucketSize: 60,
  bucketPerSecond: 30,
  /** Une place gardée après une coupure, le temps de se reconnecter (déploiement, réseau). */
  resumeMs: 60_000,
  /** Un salon vide est fermé après ce délai (le temps qu'un dernier participant revienne). */
  emptyRoomMs: 60_000,
  /** Un message du chat : 200 caractères, et cinq messages par dix secondes au plus. */
  maxChat: 200,
  chatPerWindow: 5,
  chatWindowMs: 10_000,
} as const;

/** L'alphabet des codes de salon : sans 0/O ni 1/I/L, pour se les dicter. */
export const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export const CODE_LENGTH = 6;

export type Visibility = "public" | "private";

/**
 * Les objets du chalet qui ont un état partagé (le reste du chalet est le même pour tous et n'a rien à
 * synchroniser). Chacun dit quelle valeur il accepte ; une valeur hors de ce moule est refusée.
 */
export const SHARED_OBJECTS: Record<string, (value: unknown) => boolean> = {
  "lampes.salon": (v) => typeof v === "boolean",
  "lampes.sud": (v) => typeof v === "boolean",
  "lampes.nuit": (v) => typeof v === "boolean",
  porte: (v) => typeof v === "boolean",
  feu: (v) => typeof v === "boolean",
  // La chaîne hi-fi : en marche ou non, quel morceau, et à quel instant du service il a commencé (chacun en
  // déduit la position où le reprendre).
  musique: (v) => {
    if (!v || typeof v !== "object") return false;
    const m = v as Record<string, unknown>;
    return typeof m.on === "boolean" && Number.isInteger(m.track) && (m.track as number) >= 0 && (m.track as number) < 32 && typeof m.since === "number" && Number.isFinite(m.since);
  },
};

/** Ce qu'un client peut envoyer. */
export type ClientMessage =
  | { t: "ping"; c: number }
  | { t: "list" }
  | { t: "create"; visibility: Visibility; name: string }
  | { t: "join"; code: string }
  | { t: "leave" }
  | { t: "set"; key: string; value: unknown }
  /**
   * Où l'on est : `[x, y, z, lacet, tangage, état]` — positions en centimètres, angles en milliradians, état en
   * bits (1 : assis). Des entiers : quelques octets, et rien qui ne se compare mal.
   */
  | { t: "pos"; p: number[] }
  | { t: "chat"; text: string }
  /** Demande la liste des présents signée par le service (`seal.ts`), pour préparer une partie. */
  | { t: "roster" }
  /** Lance une partie : ce que voient les joueurs, et les réponses scellées par l'application. */
  | { t: "game.start"; game: QuizGameData; sealed: string }
  | { t: "game.answer"; round: number; choice: number }
  | { t: "game.stop" }
  /**
   * La télévision commune : lancer un titre (avec le droit signé par l'application, `seal.ts` « tv »), se dire prêt
   * pour une préparation, reprendre, mettre en pause, sauter, arrêter (`tv.ts`).
   */
  | { t: "tv.open"; ticket: string; title: string; from: number }
  | { t: "tv.ready"; epoch: number }
  | { t: "tv.play" }
  | { t: "tv.pause" }
  | { t: "tv.seek"; to: number }
  | { t: "tv.stop" }
  /** Son apparence (`tv.ts`, `Look`). */
  | { t: "look"; look: Look };

/** Ce qu'un participant voit d'un autre. */
export interface MemberView {
  id: string;
  name: string;
  /** Coupé depuis peu : sa place est gardée (`LIMITS.resumeMs`). */
  away: boolean;
  /** Sa dernière position connue (voir `pos`), ou rien. */
  p?: number[] | null;
  /** Son apparence, s'il l'a dite. */
  look?: Look | null;
}

export interface RoomView {
  code: string;
  name: string;
  visibility: Visibility;
  members: MemberView[];
  /** L'état de chaque objet partagé déjà touché, avec sa version. */
  state: Record<string, { v: number; value: unknown }>;
  /** La partie de « Devine le film » en cours (ou la dernière, finie), sinon rien. */
  game: QuizView | null;
  /** La télévision commune, ou rien. */
  tv: TvView | null;
}

/** Ce que le service envoie. */
export type ServerMessage =
  | { t: "welcome"; you: { id: string; name: string }; resume: string; now: number; room: RoomView | null }
  | { t: "pong"; c: number; s: number }
  | { t: "rooms"; rooms: PublicRoomView[] }
  | { t: "joined"; room: RoomView; now: number }
  | { t: "left" }
  | { t: "enter"; member: MemberView }
  | { t: "exit"; id: string }
  | { t: "away"; id: string; away: boolean }
  | { t: "state"; key: string; v: number; value: unknown; by: string }
  | { t: "pos"; id: string; p: number[] }
  | { t: "chat"; id: string; name: string; text: string; at: number }
  | { t: "roster"; token: string }
  /** L'état de la partie ; à la fin, `result` : le bilan signé par le service, que l'application enregistre. */
  | { t: "game"; game: QuizView | null; result?: string }
  | { t: "tv"; tv: TvView | null; by?: string }
  | { t: "look"; id: string; look: Look }
  | { t: "error"; code: ErrorCode; message: string };

export type ErrorCode = "malformed" | "unknown" | "rate" | "full" | "too-many-rooms" | "no-room" | "not-in-room" | "already-in-room" | "bad-value" | "game-running" | "bad-game" | "bad-ticket";

/** Un salon public, tel que la liste le montre : qui y est (les premiers noms) et ce qui s'y passe. */
export interface PublicRoomView {
  code: string;
  name: string;
  count: number;
  max: number;
  names: string[];
  activity: "tv" | "quiz" | null;
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** Un nom saisi : texte brut, espaces resserrés, caractères de contrôle retirés, borné. */
export function cleanName(raw: unknown, max: number): string {
  if (typeof raw !== "string") return "";
  return raw
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

/** Lit un message reçu. `null` : il ne veut rien dire — le service répond `malformed`. */
export function parseClientMessage(raw: string): ClientMessage | null {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(data) || typeof data.t !== "string") return null;
  switch (data.t) {
    case "ping":
      return typeof data.c === "number" && Number.isFinite(data.c) ? { t: "ping", c: data.c } : null;
    case "list":
      return { t: "list" };
    case "create": {
      if (data.visibility !== "public" && data.visibility !== "private") return null;
      return { t: "create", visibility: data.visibility, name: cleanName(data.name, LIMITS.maxRoomName) };
    }
    case "join": {
      const code = typeof data.code === "string" ? data.code.trim().toUpperCase() : "";
      return code.length === CODE_LENGTH && [...code].every((ch) => CODE_ALPHABET.includes(ch)) ? { t: "join", code } : null;
    }
    case "leave":
      return { t: "leave" };
    case "set":
      return typeof data.key === "string" && data.key.length <= 40 && "value" in data ? { t: "set", key: data.key, value: data.value } : null;
    case "pos": {
      const p = data.p;
      if (!Array.isArray(p) || p.length !== 6 || !p.every((n) => Number.isInteger(n) && Math.abs(n) <= 100_000)) return null;
      return { t: "pos", p: p as number[] };
    }
    case "chat": {
      const text = cleanName(data.text, LIMITS.maxChat);
      return text ? { t: "chat", text } : null;
    }
    case "roster":
      return { t: "roster" };
    case "game.start": {
      const game = parseGameData(data.game);
      return game && typeof data.sealed === "string" && data.sealed.length <= 4096 ? { t: "game.start", game, sealed: data.sealed } : null;
    }
    case "game.answer":
      return Number.isInteger(data.round) && Number.isInteger(data.choice) ? { t: "game.answer", round: data.round as number, choice: data.choice as number } : null;
    case "game.stop":
      return { t: "game.stop" };
    case "tv.open": {
      const from = typeof data.from === "number" && Number.isFinite(data.from) ? Math.max(0, Math.min(data.from, 360_000)) : 0;
      const title = cleanName(data.title, 160);
      return typeof data.ticket === "string" && data.ticket.length <= 2048 && title ? { t: "tv.open", ticket: data.ticket, title, from } : null;
    }
    case "tv.ready":
      return Number.isInteger(data.epoch) ? { t: "tv.ready", epoch: data.epoch as number } : null;
    case "tv.play":
      return { t: "tv.play" };
    case "tv.pause":
      return { t: "tv.pause" };
    case "tv.seek":
      return typeof data.to === "number" && Number.isFinite(data.to) && data.to >= 0 && data.to <= 360_000 ? { t: "tv.seek", to: data.to } : null;
    case "tv.stop":
      return { t: "tv.stop" };
    case "look": {
      const look = parseLook(data.look);
      return look ? { t: "look", look } : null;
    }
    default:
      return null;
  }
}
