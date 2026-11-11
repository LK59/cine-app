import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { config } from "@/lib/config";

/**
 * L'adresse d'une image de « Devine le film » ne dit pas de quel film il s'agit (DECISIONS.md §146) : l'adresse TMDB
 * est chiffrée par l'application (sa clé de session, dérivée), et `/api/quiz/image?t=…` la rouvre. Lire le réseau ne
 * donne donc pas la réponse. Un seul nom de fichier pour toutes les images (`image`, la requête porte le reste) : le
 * pare-feu du serveur compte les noms distincts.
 */
const key = () => createHash("sha256").update(`laterna-quiz-image:${config.app.sessionSecret}`).digest();
/** Deux heures : le temps d'une partie, largement. */
const TTL_MS = 2 * 60 * 60_000;

export function quizImageUrl(source: string, now = Date.now()): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const body = Buffer.concat([cipher.update(JSON.stringify({ u: source, e: now + TTL_MS }), "utf8"), cipher.final(), cipher.getAuthTag()]);
  return `/api/quiz/image?t=${iv.toString("base64url")}.${body.toString("base64url")}`;
}

/** L'adresse TMDB d'un jeton valable, sinon `null`. */
export function openQuizImage(token: string | null, now = Date.now()): string | null {
  if (!token || token.length > 1200) return null;
  const [ivPart, bodyPart] = token.split(".");
  if (!ivPart || !bodyPart) return null;
  try {
    const iv = Buffer.from(ivPart, "base64url");
    const body = Buffer.from(bodyPart, "base64url");
    if (iv.length !== 12 || body.length < 17) return null;
    const decipher = createDecipheriv("aes-256-gcm", key(), iv);
    decipher.setAuthTag(body.subarray(body.length - 16));
    const { u, e } = JSON.parse(Buffer.concat([decipher.update(body.subarray(0, body.length - 16)), decipher.final()]).toString("utf8")) as { u: string; e: number };
    return typeof u === "string" && u.startsWith("https://image.tmdb.org/") && e > now ? u : null;
  } catch {
    return null;
  }
}
