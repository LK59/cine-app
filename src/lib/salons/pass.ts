import { createHmac } from "node:crypto";

/**
 * Le laissez-passer des salons du chalet (DECISIONS.md §146) : ce que l'application signe pour qu'une session entre
 * dans le service `laterna-salons`, qui ne connaît ni compte ni secret de session.
 *
 * Forme : `v1.<charge en base64url>.<HMAC-SHA256 de « v1.<charge> » par SALONS_KEY, en base64url>` ; la charge
 * `{ sub, name, admin, exp }`. **Le même format est vérifié côté service** (`salons/src/pass.ts`) : les deux
 * éprouvent le même vecteur (`salons-pass.test.ts` ici, `pass.test.ts` là-bas) — l'un ne peut pas changer sans que
 * l'autre le dise.
 */
export interface SalonsPassClaims {
  sub: string;
  name: string;
  admin: boolean;
  /** Millisecondes depuis l'époque. */
  exp: number;
}

/** Cinq minutes : de quoi ouvrir la connexion ; une reconnexion en redemande un. */
export const SALONS_PASS_TTL_MS = 5 * 60_000;

export function signSalonsPass(claims: SalonsPassClaims, key: string): string {
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const signature = createHmac("sha256", key).update(`v1.${payload}`).digest("base64url");
  return `v1.${payload}.${signature}`;
}
