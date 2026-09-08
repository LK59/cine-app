import { NextRequest, NextResponse } from "next/server";
import { buildStatusPayload } from "@/lib/statusPayload";
import { createRateLimiter } from "@/lib/rateLimiter";
import { getClientIp } from "@/lib/api-helpers";

export const dynamic = "force-dynamic";

/**
 * Le seul point d'entrée public qui coûte cher, donc le seul qui a besoin d'une borne.
 *
 * Une réponse en régime normal ne coûte plus rien — l'état vient du dernier relevé du cron et
 * l'historique d'un cache renouvelé au même rythme (`statusPayload.ts`). Mais `?refresh=1`, et le
 * repli quand le cron n'a pas tourné, repaient le prix fort : douze appels aux services amont et
 * ~330 ms de SQLite synchrone, pendant lesquelles better-sqlite3 tient la boucle d'événements et
 * plus rien n'est servi à personne, pas même un segment de film. Ce chemin-là reste atteignable
 * par n'importe qui, sans session : la route doit rester publique (elle existe pour répondre le
 * jour où plus rien ne répond), donc c'est la borne qui le contient.
 *
 * 30 par minute et par IP. Le besoin réel d'un onglet est de 0,5/min — `CapabilityStatus`
 * interroge à `INTERVALS.SLOW` et le `SWRConfig` global coupe `revalidateOnFocus` — donc soixante
 * fois moins que le seuil. La marge sert aux cas qui partagent une adresse : un foyer entier
 * derrière un même NAT, plusieurs onglets, les clics sur « rafraîchir », et un sondeur type
 * uptime-kuma à 60 s (1/min). Trop serré, le seuil ferait clignoter la page de quelqu'un qui la
 * garde ouverte — SWR conserve la donnée précédente (`keepPreviousData`) mais réessaie en
 * arrière-plan, ce qui creuse le trou. Trop large, il ne borne rien : 30/min plafonnent une IP
 * à 0,5 requête/s, soit ~16 % de la boucle au lieu de sa saturation.
 *
 * **Ce que « par IP » veut dire ici, et où ça s'effondre.** La clé vient de `getClientIp`
 * (`src/lib/api-helpers.ts`), qui lit le *dernier* maillon de `x-forwarded-for` — le vrai
 * client tel que le proxy inverse l'a écrit, précisément pour qu'on ne puisse pas s'inventer
 * une adresse — et qui, **en l'absence de cet en-tête, rend la chaîne littérale `"unknown"`**.
 * Autrement dit : tout ce qui atteint le conteneur sans passer par le proxy inverse partage un
 * seul et même seau de 30/min. C'est le cas de la pile de développement sur son propre port, de
 * l'accès direct depuis le réseau local, et de toute sonde interne au réseau Docker. Deux
 * conséquences opposées, aucune corrigée ici : par cette porte-là, la borne est collective —
 * quelques onglets ouverts en direct peuvent se 429 mutuellement — et elle ne protège plus
 * individuellement. Le remède serait dans `getClientIp` (distinguer « pas d'en-tête » de « une
 * adresse »), pas dans ce seuil ; en production, où tout entre par le proxy inverse, l'en-tête
 * est toujours là et la borne est bien par client.
 */
const publicStatusRateLimit = createRateLimiter(30, 60_000);

// Public — no session required (see PUBLIC_PATHS in proxy.ts). Deliberately returns only
// capability ids/statuses, never a raw hostname, port, API error message or version string —
// unlike /api/health (admin-only, behind the normal session gate — it returns internal service
// URLs, versions, and filesystem paths for troubleshooting from inside the app), this one is
// meant to be safe to expose to the open internet.
export async function GET(req: NextRequest) {
  if (!publicStatusRateLimit(getClientIp(req))) {
    return NextResponse.json({ error: "rate limited" }, { status: 429 });
  }

  // `?refresh=1` = le bouton « rafraîchir maintenant ». Tout le reste lit le dernier relevé.
  return NextResponse.json(await buildStatusPayload(req.nextUrl.searchParams.get("refresh") === "1"));
}
