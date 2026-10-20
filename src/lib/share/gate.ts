import { NextRequest, NextResponse } from "next/server";
import type { SessionPayload } from "@/lib/auth";
import { sharesDb, type Share } from "@/lib/share/store";
import { itemInShare } from "@/lib/share/scope";

/**
 * Ce qu'une session de partage peut demander (DECISIONS.md §112) — **refusé par défaut**.
 *
 * Les comptes du foyer sont l'inverse : toute lecture leur est ouverte sauf une liste, toute
 * écriture fermée sauf une liste (`proxy.ts`). Ici, une seule liste, fermée : chaque entrée nomme
 * une méthode, une adresse, et comment y lire l'élément demandé, vérifié contre le titre du lien
 * (`itemInShare`). Une route qui n'est pas ici n'existe pas pour un invité, quoi qu'en dise
 * l'écran — c'est ce qui rend sûr d'avoir réutilisé les fiches et les lecteurs de l'application.
 *
 * `body` : l'élément est dans le corps, que le proxy ne lit pas. La route vérifie elle-même
 * (`shareRefusal`, `share/guard.ts`) ; `share-gate.test.ts` échoue si l'une d'elles l'oublie.
 *
 * Ce qui n'y est pas, exprès : catalogue, recherche, listes, demandes, signalements, personnes,
 * collections, téléchargement (fichier ou hors ligne), génération de sous-titres, Chromecast,
 * nouveautés, notifications, compte, toute la gestion.
 */

type Scope =
  | { kind: "none" }
  /** L'élément est le groupe 1 de l'adresse. */
  | { kind: "path" }
  /** L'élément est dans `?itemId=`. */
  | { kind: "query" }
  /** La série elle-même, et seulement elle (ses épisodes, listés). */
  | { kind: "series" }
  | { kind: "radarr" }
  | { kind: "sonarr" }
  | { kind: "body" };

interface Rule {
  methods: readonly string[];
  path: RegExp;
  scope: Scope;
}

const ID = "([0-9a-fA-F]{32})";
const NONE: Scope = { kind: "none" };
const PATH: Scope = { kind: "path" };
const QUERY: Scope = { kind: "query" };
const BODY: Scope = { kind: "body" };

export const SHARE_RULES: readonly Rule[] = [
  // La page du lien et sa session.
  { methods: ["GET"], path: /^\/api\/share\/title$/, scope: NONE },
  { methods: ["GET"], path: /^\/api\/auth\/me$/, scope: NONE },
  { methods: ["POST"], path: /^\/api\/auth\/logout$/, scope: NONE },
  // Ce que la racine de toute page demande : langue et préférences locales, maintenance, version,
  // erreurs du navigateur, présence (l'administrateur voit l'invité regarder).
  { methods: ["GET", "PUT"], path: /^\/api\/user\/preferences$/, scope: NONE },
  { methods: ["GET"], path: /^\/api\/maintenance$/, scope: NONE },
  { methods: ["GET"], path: /^\/api\/version$/, scope: NONE },
  { methods: ["POST"], path: /^\/api\/client-error$/, scope: NONE },
  { methods: ["POST"], path: /^\/api\/startup-timing$/, scope: NONE },
  { methods: ["POST"], path: /^\/api\/presence$/, scope: NONE },
  // « Reprendre » et « À suivre » du compte du lien : il n'a jamais regardé que ce titre.
  { methods: ["GET"], path: /^\/api\/jellyfin\/resume$/, scope: NONE },
  { methods: ["GET"], path: /^\/api\/cinema\/next-up$/, scope: NONE },
  // La fiche.
  { methods: ["GET"], path: new RegExp(`^/api/cinema/series/${ID}/episodes$`), scope: { kind: "series" } },
  { methods: ["GET"], path: new RegExp(`^/api/cinema/progress/${ID}$`), scope: PATH },
  { methods: ["GET"], path: /^\/api\/radarr\/movies\/(\d+)\/info$/, scope: { kind: "radarr" } },
  { methods: ["GET"], path: /^\/api\/sonarr\/series\/(\d+)\/info$/, scope: { kind: "sonarr" } },
  { methods: ["GET"], path: /^\/api\/jellyfin\/image$/, scope: QUERY },
  // Les deux lecteurs.
  { methods: ["GET"], path: new RegExp(`^/api/jellyfin/direct/${ID}$`), scope: PATH },
  { methods: ["GET"], path: new RegExp(`^/api/jellyfin/playback-state/${ID}$`), scope: PATH },
  { methods: ["GET", "HEAD"], path: new RegExp(`^/api/jellyfin/stream/subtitle/${ID}$`), scope: PATH },
  { methods: ["GET", "HEAD"], path: new RegExp(`^/api/jellyfin/stream/${ID}/.+$`), scope: PATH },
  { methods: ["GET"], path: /^\/api\/jellyfin\/trickplay\/(?:info|tile)$/, scope: QUERY },
  { methods: ["GET"], path: /^\/api\/jellyfin\/chapters$/, scope: QUERY },
  { methods: ["GET"], path: new RegExp(`^/api/player/item/${ID}$`), scope: PATH },
  { methods: ["GET"], path: new RegExp(`^/api/player/frame/${ID}$`), scope: PATH },
  { methods: ["POST"], path: /^\/api\/jellyfin\/playback\/(?:start|playing|progress|stop)$/, scope: BODY },
  { methods: ["POST"], path: /^\/api\/player\/series-language$/, scope: BODY },
  { methods: ["POST"], path: /^\/api\/player\/log$/, scope: BODY },
];

/** La règle qui couvre cette requête, s'il y en a une. */
export function shareRuleFor(method: string, pathname: string): { rule: Rule; match: RegExpExecArray } | null {
  for (const rule of SHARE_RULES) {
    if (!rule.methods.includes(method)) continue;
    const match = rule.path.exec(pathname);
    if (match) return { rule, match };
  }
  return null;
}

/** La requête reste-t-elle dans le titre du lien ? */
export async function shareAllows(share: Share, method: string, url: URL): Promise<boolean> {
  const found = shareRuleFor(method, url.pathname);
  if (!found) return false;
  const { rule, match } = found;
  switch (rule.scope.kind) {
    case "none":
    case "body":
      return true;
    case "path":
      return itemInShare(share, match[1]?.toLowerCase());
    case "query":
      return itemInShare(share, url.searchParams.get("itemId")?.toLowerCase());
    case "series":
      return share.kind === "series" && match[1]?.toLowerCase() === share.itemId;
    case "radarr":
      return share.kind === "movie" && share.radarrId !== null && Number(match[1]) === share.radarrId;
    case "sonarr":
      return share.kind === "series" && share.sonarrId !== null && Number(match[1]) === share.sonarrId;
  }
}

/** L'adresse de la page d'un lien. */
export function sharePagePath(code: string): string {
  return `/partage/${code}`;
}

/**
 * Le proxy, pour une session de partage — appelé une fois la session vérifiée (`verifySessionFull`
 * a déjà refusé un lien révoqué ou passé). Une page autre que celle du lien y ramène ; une API hors
 * de la liste, ou hors du titre, répond 403.
 */
export async function shareGate(req: NextRequest, session: SessionPayload): Promise<NextResponse> {
  const share = sharesDb.get(session.sh ?? "");
  if (!share) return NextResponse.json({ error: "Lien de partage inconnu" }, { status: 403 });
  const { pathname } = req.nextUrl;
  if (!pathname.startsWith("/api/")) {
    // La page du lien est publique (elle demande le mot de passe) et passe avant ; toute autre page
    // — l'accueil, la gestion, une adresse tapée — ramène à la fiche partagée.
    return NextResponse.redirect(new URL(sharePagePath(share.code), req.url));
  }
  if (!(await shareAllows(share, req.method, req.nextUrl))) {
    return NextResponse.json({ error: "Ce lien ne donne accès qu'au titre partagé", code: "share-scope" }, { status: 403 });
  }
  return NextResponse.next();
}
