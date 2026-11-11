import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Le laissez-passer : la seule chose qui fait entrer dans un salon.
 *
 * L'application de Laterna le délivre (`GET /api/salons/pass`, derrière la session) et le signe avec la clé
 * partagée `SALONS_KEY` ; le service le vérifie à la connexion. Le service ne connaît donc ni compte, ni mot de
 * passe, ni secret de session : il croit ce que la signature garantit, pour quelques minutes.
 *
 * Forme : `v1.<charge en base64url>.<signature en base64url>`, la signature étant un HMAC-SHA256 de
 * `v1.<charge>` par la clé. La charge : `{ sub, name, admin, exp }` — l'identifiant du compte, son nom
 * affiché, administrateur ou non, l'expiration en millisecondes depuis l'époque.
 *
 * **Le même format est écrit côté application** (`src/lib/salons/pass.ts`) : les deux côtés éprouvent le même
 * vecteur de test (`PASS_TEST_VECTOR`), pour qu'ils ne puissent pas diverger sans qu'un test le dise.
 */
export interface PassClaims {
  /** L'identifiant du compte (celui de Jellyfin quand il existe). */
  sub: string;
  /** Le nom à afficher au-dessus de l'avatar et dans le chat. */
  name: string;
  admin: boolean;
  /** Expiration, en millisecondes depuis l'époque. */
  exp: number;
}

const PREFIX = "v1.";

const b64url = (data: Buffer | string) => Buffer.from(data).toString("base64url");

export function signPass(claims: PassClaims, key: string): string {
  const payload = b64url(JSON.stringify(claims));
  const signature = createHmac("sha256", key).update(PREFIX + payload).digest("base64url");
  return `${PREFIX}${payload}.${signature}`;
}

/** Les champs d'une charge, vérifiés un par un : une charge signée mais mal formée reste refusée. */
function claimsOf(value: unknown): PassClaims | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (typeof v.sub !== "string" || v.sub.length === 0 || v.sub.length > 64) return null;
  if (typeof v.name !== "string" || v.name.length === 0 || v.name.length > 64) return null;
  if (typeof v.admin !== "boolean" || typeof v.exp !== "number" || !Number.isFinite(v.exp)) return null;
  return { sub: v.sub, name: v.name, admin: v.admin, exp: v.exp };
}

/** La charge d'un laissez-passer valable et non expiré, sinon `null` — sans dire pourquoi. */
export function verifyPass(token: string, key: string, now = Date.now()): PassClaims | null {
  if (typeof token !== "string" || token.length > 1024 || !token.startsWith(PREFIX)) return null;
  const rest = token.slice(PREFIX.length);
  const dot = rest.indexOf(".");
  if (dot <= 0) return null;
  const payload = rest.slice(0, dot);
  const given = Buffer.from(rest.slice(dot + 1), "base64url");
  const expected = createHmac("sha256", key).update(PREFIX + payload).digest();
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  let claims: PassClaims | null;
  try {
    claims = claimsOf(JSON.parse(Buffer.from(payload, "base64url").toString("utf8")));
  } catch {
    return null;
  }
  if (!claims || claims.exp <= now) return null;
  return claims;
}

/**
 * Le vecteur partagé avec l'application : cette clé et cette charge doivent donner exactement ce jeton, des deux
 * côtés (`pass.test.ts` ici, `salons-pass.test.ts` dans l'application).
 */
export const PASS_TEST_VECTOR = {
  key: "clé-de-test-des-salons-0123456789abcdef",
  claims: { sub: "compte-1", name: "Invité", admin: false, exp: 1_900_000_000_000 },
  token:
    "v1.eyJzdWIiOiJjb21wdGUtMSIsIm5hbWUiOiJJbnZpdMOpIiwiYWRtaW4iOmZhbHNlLCJleHAiOjE5MDAwMDAwMDAwMDB9.7JNtXr6Je61wDZQ1hihlJ9O8h5riQ19H2gJuZshll4Q",
} as const;
