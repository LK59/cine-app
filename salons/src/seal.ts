import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Ce que le service et l'application se passent par les mains des joueurs, sans qu'un joueur puisse le lire ou le
 * fabriquer. Une seule écriture, importée telle quelle des deux côtés (`src/lib/quiz/` dans l'application) : la clé
 * est la clé partagée `SALONS_KEY`, dérivée par usage — une signature d'un usage ne vaut rien pour un autre.
 *
 * - **Les réponses d'une partie** (`sealAnswers` / `openAnswers`) : chiffrées par l'application (AES-256-GCM), ouvertes
 *   par le service seul. Le joueur qui lance la partie les transporte sans pouvoir les lire.
 * - **La liste des présents** (`roster`) : signée par le service, pour que l'application tire les titres que **tous**
 *   peuvent voir — un joueur ne peut pas s'inventer des compagnons.
 * - **Le résultat d'une partie** (`result`) : signé par le service, pour que l'application n'enregistre de records à
 *   plusieurs que ceux qu'il a comptés.
 * - **Le titre de la télévision commune** (`tv`) : signé par l'application, après avoir vérifié que tous les présents
 *   peuvent le voir.
 */
export type SealPurpose = "roster" | "result" | "tv";

const derive = (key: string, purpose: string) => createHash("sha256").update(`laterna-salons:${purpose}:${key}`).digest();
const b64 = (data: Buffer | string) => Buffer.from(data).toString("base64url");

export function signValue(value: unknown, key: string, purpose: SealPurpose): string {
  const payload = b64(JSON.stringify(value));
  return `v1.${payload}.${createHmac("sha256", derive(key, purpose)).update(payload).digest("base64url")}`;
}

/** La valeur d'une signature valable pour cet usage, sinon `null`. */
export function verifyValue<T>(token: unknown, key: string, purpose: SealPurpose): T | null {
  if (typeof token !== "string" || token.length > 16_384 || !token.startsWith("v1.")) return null;
  const [payload, signature] = token.slice(3).split(".");
  if (!payload || !signature) return null;
  const given = Buffer.from(signature, "base64url");
  const expected = createHmac("sha256", derive(key, purpose)).update(payload).digest();
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as T;
  } catch {
    return null;
  }
}

export interface SealedAnswers {
  gameId: string;
  answers: number[];
  /** Millisecondes depuis l'époque : une partie préparée se joue dans l'heure. */
  exp: number;
}

export function sealAnswers(value: SealedAnswers, key: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", derive(key, "answers"), iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final(), cipher.getAuthTag()]);
  return `v1.${b64(iv)}.${b64(body)}`;
}

export function openAnswers(token: unknown, key: string, now = Date.now()): SealedAnswers | null {
  if (typeof token !== "string" || token.length > 4096 || !token.startsWith("v1.")) return null;
  const [ivPart, bodyPart] = token.slice(3).split(".");
  if (!ivPart || !bodyPart) return null;
  try {
    const iv = Buffer.from(ivPart, "base64url");
    const body = Buffer.from(bodyPart, "base64url");
    if (iv.length !== 12 || body.length < 17) return null;
    const decipher = createDecipheriv("aes-256-gcm", derive(key, "answers"), iv);
    decipher.setAuthTag(body.subarray(body.length - 16));
    const plain = Buffer.concat([decipher.update(body.subarray(0, body.length - 16)), decipher.final()]).toString("utf8");
    const value = JSON.parse(plain) as SealedAnswers;
    if (typeof value.gameId !== "string" || !Array.isArray(value.answers) || !value.answers.every((a) => Number.isInteger(a) && a >= 0 && a <= 3)) return null;
    if (typeof value.exp !== "number" || value.exp <= now) return null;
    return value;
  } catch {
    return null;
  }
}

/** Les présents d'un salon, signés par le service : ce que l'application croit pour choisir les titres. */
export interface Roster {
  room: string;
  /** Les comptes présents (`sub` des laissez-passer). */
  subs: string[];
  exp: number;
}

/**
 * Le droit de lancer un titre sur la télévision commune d'un salon, signé par l'application après avoir vérifié que
 * **chaque** présent peut voir ce titre (ses tags bloqués, sa bibliothèque). Le service ne lance rien d'autre.
 */
export interface TvTicket {
  room: string;
  itemId: string;
  exp: number;
}

/** Le résultat d'une partie à plusieurs, signé par le service. */
export interface SignedResult {
  gameId: string;
  variant: string;
  room: string;
  at: number;
  players: { sub: string; name: string; score: number; correct: number; total: number; bestStreak: number }[];
}
