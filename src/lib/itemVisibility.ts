import { NextResponse } from "next/server";
import { config } from "@/lib/config";
import { jellyfinAuthHeaders } from "@/lib/jellyfinAuth";
import { jellyfinIdSegment } from "@/lib/jellyfinPath";
import type { SessionPayload } from "@/lib/auth";

/**
 * Ce compte a-t-il le droit de voir cet élément ? La question est posée à Jellyfin, et à lui seul.
 *
 * Les routes qui servent des octets de Jellyfin — le relais de flux, les sous-titres, les images,
 * les vignettes de la barre — signent avec la clé d'administration, qui voit tout. Elles ne
 * vérifiaient que la présence d'une session : les `BlockedTags`, les bibliothèques permises et le
 * contrôle parental d'un compte ne s'appliquaient donc jamais à ce qu'elles servaient. L'interface
 * butait bien sur `direct/[itemId]`, qui passe par `/Users/{jfId}/Items` ; mais le catalogue donne à
 * chaque compte l'identifiant de *tous* les titres, et une adresse de flux fabriquée à la main
 * ouvrait un film bloqué (audit du 29/09/2026).
 *
 * La réponse est celle de `/Users/{jfId}/Items/{itemId}`, le même appel que `direct/[itemId]` : clé
 * d'administration **et** identifiant du compte, que Jellyfin passe au filtre de ce compte (un
 * élément hors de ses droits répond 404, ou 401 « not permitted » selon la version). Aucune règle
 * de visibilité n'est réécrite ici — une seconde copie des règles de Jellyfin divergerait.
 *
 * Le verdict est gardé par `(jti, itemId)` : un film demande un segment ou une plage toutes les
 * quelques secondes, et une rangée d'images en demande vingt d'un coup. Une question par séance
 * et par titre, pas une par octet.
 */

/** Un titre vu comme visible le reste pendant une séance de visionnage, et bien au-delà d'un film. */
const VISIBLE_TTL_MS = 6 * 60 * 60 * 1000;
/**
 * Un refus est reposé plus tôt : l'administrateur qui débloque un titre ne doit pas attendre six
 * heures qu'il s'ouvre.
 */
const HIDDEN_TTL_MS = 5 * 60 * 1000;
/** Borne de la mémoire : quelques comptes, quelques centaines de titres chacun. */
const MAX_ENTRIES = 5000;
const CHECK_TIMEOUT_MS = 5000;

interface Verdict {
  visible: boolean;
  at: number;
}

const verdicts = new Map<string, Verdict>();
const inflight = new Map<string, Promise<boolean | null>>();

/** Pour les tests : repartir d'une mémoire vide. */
export function forgetVisibility(): void {
  verdicts.clear();
  inflight.clear();
}

function remember(key: string, visible: boolean, now: number): void {
  // Réinsérée pour passer en fin d'ordre : la `Map` garde l'ordre d'insertion, et la plus
  // ancienne est la première à partir quand la borne est atteinte.
  verdicts.delete(key);
  verdicts.set(key, { visible, at: now });
  while (verdicts.size > MAX_ENTRIES) {
    const oldest = verdicts.keys().next().value;
    if (oldest === undefined) break;
    verdicts.delete(oldest);
  }
}

/**
 * `true` visible, `false` refusé, `null` Jellyfin n'a pas pu répondre.
 *
 * Toute réponse 4xx est un refus : 404 (élément hors des droits, ou inexistant), 401/403 (« not
 * permitted »). Une clé mal configurée répondrait aussi 401 — mais l'appel signé qui suivrait
 * échouerait de toute façon ; refuser ici ne ferme rien qui aurait marché.
 */
async function askJellyfin(jfId: string, itemId: string): Promise<boolean | null> {
  try {
    const res = await fetch(
      `${config.jellyfin.url}/Users/${jellyfinIdSegment(jfId)}/Items/${jellyfinIdSegment(itemId)}`,
      { headers: jellyfinAuthHeaders(config.jellyfin.apiKey), signal: AbortSignal.timeout(CHECK_TIMEOUT_MS), cache: "no-store" }
    );
    // Lu jusqu'au bout : une réponse abandonnée garde sa connexion ouverte.
    await res.arrayBuffer().catch(() => undefined);
    if (res.ok) return true;
    if (res.status >= 400 && res.status < 500) return false;
    return null;
  } catch {
    return null;
  }
}

/**
 * `null` si la requête peut continuer ; sinon la réponse à renvoyer telle quelle, sans détail.
 *
 * - Pas de session, ou un compte sans identité Jellyfin (hors administrateur) : 403.
 * - Un administrateur passe : c'est lui qui tient la clé, et la gestion montre toute la
 *   bibliothèque (y compris depuis le compte administrateur local, qui n'a pas de `jfId`).
 * - Refusé par Jellyfin : 404 — ne pas dire à quelqu'un qu'un titre qu'il ne doit pas voir existe.
 * - Jellyfin injoignable : un verdict « visible » déjà obtenu dans cette séance vaut encore, même
 *   périmé — une coupure de quelques secondes chez Jellyfin ne doit pas arrêter un film en cours.
 *   Jamais vérifié : 503. Une panne n'ouvre jamais l'accès.
 *
 * Le laissez-passer de diffusion (`castPassFor`) ne passe **pas** par ici : un téléviseur n'a pas de
 * cookie, et le jeton ne porte que le nom du compte de l'application, pas son `jfId`. Il est émis
 * par `playback/start`, qui négocie avec Jellyfin sous l'identité du compte ; le faire porter le
 * `jfId` pour revérifier ici changerait son format, ce qui est un autre chantier.
 */
export async function assertVisible(
  session: Pick<SessionPayload, "jti" | "role" | "jfId"> | null | undefined,
  itemId: string,
  now = Date.now()
): Promise<NextResponse | null> {
  if (!session) return new NextResponse(null, { status: 403 });
  if (session.role === "admin") return null;
  if (!session.jfId || !session.jti) return new NextResponse(null, { status: 403 });

  const key = `${session.jti}:${itemId}`;
  const known = verdicts.get(key);
  if (known && now - known.at < (known.visible ? VISIBLE_TTL_MS : HIDDEN_TTL_MS)) {
    return known.visible ? null : new NextResponse(null, { status: 404 });
  }

  // Les segments d'un démarrage arrivent ensemble : une seule question pour tous.
  let pending = inflight.get(key);
  if (!pending) {
    pending = askJellyfin(session.jfId, itemId).finally(() => inflight.delete(key));
    inflight.set(key, pending);
  }
  const answer = await pending;

  if (answer === null) {
    if (known?.visible) return null;
    return new NextResponse(null, { status: 503 });
  }
  remember(key, answer, now);
  return answer ? null : new NextResponse(null, { status: 404 });
}
