import { config } from "@/lib/config";
import { isJellyfinId } from "@/lib/jellyfinPath";

/**
 * Le laissez-passer d'un téléviseur pour un seul film.
 *
 * Une Apple TV ou un Chromecast ne diffuse pas ce que la page lui envoie : il reçoit une adresse
 * et va chercher le flux **lui-même**. Il n'a donc ni notre cookie ni aucun moyen d'en avoir un.
 * Sans ce jeton, tout ce qu'il demande repart en 401 et le film ne démarre jamais.
 *
 * Trois bornes, et elles sont le cœur du sujet :
 *
 *   - **Un seul titre.** L'identifiant est signé *dans* le jeton et revérifié contre celui de
 *     l'adresse demandée. Un laissez-passer pour un film n'ouvre aucun autre.
 *   - **Lecture seule, et une seule route.** Seul `/api/jellyfin/stream/{itemId}/…` le regarde.
 *     Rien d'autre du site ne devient joignable sans session.
 *   - **Six heures.** Assez pour un film et ses reprises — le téléviseur va chercher un segment
 *     toutes les quelques secondes pendant toute la séance, et un jeton court couperait la lecture
 *     en son milieu, ce qui est la panne qu'on ne veut surtout pas fabriquer.
 *
 * Six heures pour un film paraît long ; c'est à comparer à ce qu'un cookie perdu donnerait — sept
 * jours sur l'application entière, écritures comprises. Ce jeton est strictement plus étroit que
 * ce qui existait déjà.
 *
 * La clé est **dérivée** de `SESSION_SECRET` et non `SESSION_SECRET` lui-même, avec son propre
 * préfixe de domaine — même précaution que la clé de chiffrement de la session. Un jeton de
 * diffusion ne doit jamais pouvoir être présenté comme un jeton de session, ni l'inverse, même si
 * un jour les deux formats venaient à se ressembler.
 */
const LIFETIME_MS = 6 * 60 * 60 * 1000;

function base64url(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let str = "";
  for (const byte of view) str += String.fromCharCode(byte);
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64url(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (value.length % 4)) % 4);
  const str = atob(padded);
  const bytes = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) bytes[i] = str.charCodeAt(i);
  return bytes;
}

async function getKey(): Promise<CryptoKey> {
  // Dérivée, et avec son propre préfixe : voir l'en-tête. `SESSION_SECRET` est une chaîne choisie
  // à la main, de longueur quelconque ; le condensé donne une clé de taille fixe sans imposer de
  // contrainte à la configuration.
  const material = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`cast:${config.app.sessionSecret}`));
  return crypto.subtle.importKey("raw", material, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

interface CastClaims {
  /** Le titre, et lui seul. */
  i: string;
  /** Qui a demandé la diffusion — pour le journal, jamais pour décider. */
  u: string;
  /** Fin de validité, en ms. */
  e: number;
}

/** Le laissez-passer pour ce titre, à coller dans l'adresse donnée au téléviseur. */
export async function signCastToken(itemId: string, userId: string, now = Date.now()): Promise<string> {
  const payload = base64url(new TextEncoder().encode(JSON.stringify({ i: itemId, u: userId, e: now + LIFETIME_MS } satisfies CastClaims)));
  const signature = base64url(await crypto.subtle.sign("HMAC", await getKey(), new TextEncoder().encode(payload)));
  return `${payload}.${signature}`;
}

/**
 * Le jeton ouvre-t-il bien ce titre-ci, maintenant ?
 *
 * Renvoie le compte qui l'a demandé, ou `null`. Jamais d'exception : ceci est appelé depuis le
 * proxy, sur le chemin de *toutes* les requêtes de flux, et une vérification qui lève à la place
 * d'un refus transformerait un jeton malformé en panne de l'application entière.
 */
export async function verifyCastToken(token: string | null | undefined, itemId: string, now = Date.now()): Promise<string | null> {
  if (!token) return null;
  try {
    const [payload, signature] = token.split(".");
    if (!payload || !signature) return null;

    const expected = await crypto.subtle.sign("HMAC", await getKey(), new TextEncoder().encode(payload));
    const given = fromBase64url(signature);
    const mine = new Uint8Array(expected);
    if (given.length !== mine.length) return null;
    // Comparaison à temps constant : une comparaison qui s'arrête au premier octet différent
    // laisse deviner la signature attendue, octet par octet.
    let diff = 0;
    for (let i = 0; i < mine.length; i++) diff |= mine[i] ^ given[i];
    if (diff !== 0) return null;

    const claims = JSON.parse(new TextDecoder().decode(fromBase64url(payload))) as Partial<CastClaims>;
    // L'identifiant du titre est revérifié contre celui de l'adresse : un jeton signé reste un
    // jeton pour *son* film, même présenté sur le chemin d'un autre.
    if (typeof claims.i !== "string" || claims.i !== itemId) return null;
    if (typeof claims.e !== "number" || claims.e <= now) return null;
    if (typeof claims.u !== "string" || !claims.u) return null;
    return claims.u;
  } catch {
    return null;
  }
}

/** Le nom du paramètre, écrit une seule fois : le proxy, la route et la réécriture le partagent. */
export const CAST_TOKEN_PARAM = "castToken";

/**
 * Cette requête est-elle celle d'un téléviseur muni d'un laissez-passer valable ?
 *
 * Écrite ici, en un seul endroit, parce que deux gardes la posent : le proxy — qui refuse tout
 * `/api/` sans session — et la route de flux elle-même, qui revérifie pour son compte. Deux
 * formulations de la même question finiraient par diverger, et celle-ci décide d'un accès sans
 * cookie : c'est exactement la question qu'il ne faut pas écrire deux fois.
 *
 * Volontairement étroite, et chaque borne compte :
 *
 *   - **GET seulement.** Rien ne s'écrit avec un laissez-passer.
 *   - **Le préfixe exact du flux**, et un identifiant qui doit passer `isJellyfinId` — pas une
 *     sous-chaîne, pas un chemin voisin.
 *   - **Le jeton doit nommer ce titre-là.** C'est `verifyCastToken` qui le dit, pas l'adresse.
 *
 * Renvoie le compte qui a demandé la diffusion, ou `null`.
 */
export async function castPassFor(req: {
  method: string;
  nextUrl: { pathname: string; searchParams: URLSearchParams };
}): Promise<string | null> {
  if (req.method !== "GET") return null;
  const itemId = castItemOf(req.nextUrl.pathname);
  if (!itemId) return null;
  return verifyCastToken(req.nextUrl.searchParams.get(CAST_TOKEN_PARAM), itemId);
}

/**
 * Le titre que cette adresse sert, quand elle fait partie de ce qu'une diffusion doit atteindre.
 *
 * Deux formes, et la seconde manquait. Les segments et les manifestes vivent sous
 * `/api/jellyfin/stream/{id}/…` ; les sous-titres, eux, sous `/api/jellyfin/stream/subtitle/{id}`
 * — le titre n'y est pas au même rang, si bien que la règle ne les reconnaissait pas et que le
 * téléviseur recevait un 401 sur chacun d'eux. Vérifié en direct le 19/09/2026 : le manifeste
 * répond 200 avec un laissez-passer, la piste de sous-titres 401 avec le même.
 *
 * C'est ce qui explique ce qu'on voyait à l'écran — « des sous-titres français / anglais alors
 * qu'il y en a plein de types » : les seuls qui arrivaient étaient ceux que le téléviseur devinait
 * lui-même, aucun des nôtres.
 */
export function castItemOf(pathname: string): string | null {
  const direct = /^\/api\/jellyfin\/stream\/subtitle\/([^/?]+)$/.exec(pathname);
  if (direct) return isJellyfinId(direct[1]) ? direct[1] : null;
  const match = /^\/api\/jellyfin\/stream\/([^/]+)\//.exec(pathname);
  if (!match) return null;
  return isJellyfinId(match[1]) ? match[1] : null;
}

/**
 * Reporte le laissez-passer dans chaque adresse que le manifeste désigne.
 *
 * La ligne qui décide si la diffusion dure deux heures ou deux secondes. Le téléviseur ne reçoit
 * de nous qu'**une** adresse, celle du manifeste ; tout le reste — variantes, pistes de
 * sous-titres, et surtout les centaines de segments — il le déduit de son contenu. Sans jeton sur
 * ces adresses-là, la première requête passe et toutes les suivantes sont refusées.
 *
 * Écrite ici plutôt que dans la route pour pouvoir être mise à l'épreuve sur de vrais manifestes :
 * une expression régulière qui rate une forme d'URL ne se voit qu'à l'usage, et tard.
 */
export function withCastPass(manifest: string, itemId: string, pass: string): string {
  const prefix = `/api/jellyfin/stream/${itemId}/`;
  const sign = (url: string) => {
    if (url.includes(`${CAST_TOKEN_PARAM}=`)) return url;
    // Une adresse absolue doit désigner ce titre-là chez nous ; tout le reste — un autre titre,
    // un autre hôte — repart intact. Une adresse relative, elle, se résout forcément sous le
    // manifeste, donc sous ce même titre : c'est la forme que Jellyfin emploie vraiment pour ses
    // pistes de sous-titres et ses variantes, et celle qui manquait (relevé le 22/09/2026 — le
    // téléviseur répondait 401 sur chaque piste et restait en chargement).
    if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return url;
    if (url.startsWith("/") && !url.startsWith(prefix)) return url;
    return `${url}${url.includes("?") ? "&" : "?"}${CAST_TOKEN_PARAM}=${encodeURIComponent(pass)}`;
  };

  return manifest
    .split("\n")
    .map((line) => {
      // Une ligne d'attributs porte ses adresses dans `URI="…"` ; une ligne nue *est* une adresse.
      if (line.startsWith("#")) return line.replace(/URI="([^"]*)"/g, (_m, url: string) => `URI="${sign(url)}"`);
      // Un manifeste peut arriver en CRLF : signer la ligne entière emporterait le retour chariot
      // dans l'adresse.
      return line.replace(/^(\s*)(\S+)(\s*)$/, (_m, before: string, url: string, after: string) => `${before}${sign(url)}${after}`);
    })
    .join("\n");
}
