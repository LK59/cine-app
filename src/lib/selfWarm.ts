import { randomBytes } from "node:crypto";
import { fromLoopback } from "@/lib/trustedProxy";
import { timingSafeEquals } from "@/lib/timingSafeEquals";
import { LOCALE_COOKIE } from "@/lib/i18n";

/**
 * Le catalogue construit par ses propres routes dès le démarrage du conteneur (15/10/2026).
 *
 * Les listes de Radarr, Sonarr et Jellyfin sont lues au démarrage (`catalogueWarm`), mais la première
 * ouverture après un déploiement payait encore 390 ms de route pour les films (mesuré en prod le
 * 15/10, 8.65.5) : la route relit, titre par titre, ce que la base garde de chacun (logo, affiches,
 * titres traduits, résumés, accroches) et le garde en mémoire — dans *son* exemplaire des modules,
 * que le démarrage ne peut pas remplir d'ici (`instrumentation.ts` et les routes sont compilés en
 * points d'entrée séparés, voir `server-cache.ts`). La seule façon sûre de préparer ce que la route
 * lira est donc de l'appeler, elle : le serveur se demande ses deux catalogues sur la boucle locale,
 * et jette la réponse.
 *
 * Sans session : la demande porte un jeton tiré au démarrage (dans `process.env`, que tous les
 * exemplaires des modules partagent) et doit venir de la machine elle-même, connexion à l'appui
 * (`fromLoopback`, posé par `server-boot/boot.mjs`). Les deux conditions, sur deux adresses en GET
 * seulement : la réponse — le catalogue entier, sans les tags bloqués d'aucun compte — ne sort jamais
 * de la boucle locale. Sous `next dev`, sans connexion notée, rien ne passe et rien n'est préchauffé.
 */
export const SELF_WARM_HEADER = "x-cine-self-warm";
export const SELF_WARM_PATHS: readonly string[] = ["/api/cinema/movies", "/api/cinema/series"];
const TOKEN_ENV = "CINE_SELF_WARM_TOKEN";

function token(): string {
  return (process.env[TOKEN_ENV] ??= randomBytes(32).toString("base64url"));
}

/** Le laissez-passer du proxy : la boucle locale, le jeton, un GET sur l'une des deux adresses. */
export function selfWarmPassFor(req: { method: string; nextUrl: { pathname: string }; headers?: { get(name: string): string | null } }): boolean {
  if (req.method !== "GET" || !SELF_WARM_PATHS.includes(req.nextUrl.pathname)) return false;
  // Le jeton d'abord : sans préchauffage dans ce processus, rien d'autre n'est lu.
  const expected = process.env[TOKEN_ENV];
  if (!expected || !req.headers) return false;
  const presented = req.headers.get(SELF_WARM_HEADER);
  if (!presented) return false;
  return fromLoopback(req.headers) === true && timingSafeEquals(presented, expected);
}

/** Le serveur n'écoute peut-être pas encore quand le démarrage l'appelle : quelques essais espacés. */
const ATTEMPTS = 10;
const RETRY_MS = 3_000;

export async function runSelfWarm(port = process.env.PORT || "3000"): Promise<void> {
  const secret = token();
  for (const path of SELF_WARM_PATHS) {
    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}${path}`, {
          headers: {
            [SELF_WARM_HEADER]: secret,
            // La langue par défaut de l'installation ; ce que la route garde de chaque titre ne
            // dépend pas de la langue, seule sa réponse préparée en dépend.
            cookie: `${LOCALE_COOKIE}=fr`,
            // Le brotli de cette réponse se calcule dès maintenant, hors du fil principal.
            "accept-encoding": "br, gzip",
          },
        });
        await res.arrayBuffer();
        break;
      } catch {
        await new Promise((r) => setTimeout(r, RETRY_MS));
      }
    }
  }
}
