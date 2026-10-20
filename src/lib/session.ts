// Node.js only (better-sqlite3 is a native module) — safe to import from src/proxy.ts since
// Next.js 16's Proxy always runs on the Node.js runtime (unlike the old Edge-only middleware).
import { verifySessionToken, SESSION_COOKIE, type SessionPayload } from "@/lib/auth";
import { sessionDb } from "@/lib/db";
import { shareIsActive, sharesDb } from "@/lib/share/store";

export type { SessionPayload };
export { SESSION_COOKIE };

// Full session verification: HMAC + expiry + server-side revocation check
export async function verifySessionFull(
  token: string | undefined | null
): Promise<SessionPayload | null> {
  const payload = await verifySessionToken(token);
  if (!payload) return null;
  // Un jeton sans `jti` ne peut pas être révoqué : il était toléré le temps que les jetons émis
  // avant la révocation expirent, ce qui est fait depuis longtemps. Le tolérer encore, c'est
  // garder une porte que rien ne referme.
  if (!payload.jti || !sessionDb.exists(payload.jti)) return null;
  // Une session de partage ne vit pas plus que son lien : révoqué ou passé, elle tombe à la requête
  // suivante — un film en cours compris (DECISIONS.md §112). Une ligne lue par clé primaire.
  if (payload.role === "share" && !shareIsActive(sharesDb.get(payload.sh ?? ""))) return null;
  return payload;
}
