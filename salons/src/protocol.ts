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
  | { t: "set"; key: string; value: unknown };

/** Ce qu'un participant voit d'un autre. */
export interface MemberView {
  id: string;
  name: string;
  /** Coupé depuis peu : sa place est gardée (`LIMITS.resumeMs`). */
  away: boolean;
}

export interface RoomView {
  code: string;
  name: string;
  visibility: Visibility;
  members: MemberView[];
  /** L'état de chaque objet partagé déjà touché, avec sa version. */
  state: Record<string, { v: number; value: unknown }>;
}

/** Ce que le service envoie. */
export type ServerMessage =
  | { t: "welcome"; you: { id: string; name: string }; resume: string; now: number; room: RoomView | null }
  | { t: "pong"; c: number; s: number }
  | { t: "rooms"; rooms: { code: string; name: string; count: number; max: number }[] }
  | { t: "joined"; room: RoomView; now: number }
  | { t: "left" }
  | { t: "enter"; member: MemberView }
  | { t: "exit"; id: string }
  | { t: "away"; id: string; away: boolean }
  | { t: "state"; key: string; v: number; value: unknown; by: string }
  | { t: "error"; code: ErrorCode; message: string };

export type ErrorCode = "malformed" | "unknown" | "rate" | "full" | "too-many-rooms" | "no-room" | "not-in-room" | "already-in-room" | "bad-value";

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
    default:
      return null;
  }
}
