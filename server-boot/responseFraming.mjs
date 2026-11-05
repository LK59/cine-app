// Le cadrage des réponses (`Content-Encoding`, `Content-Length`), posé au moment où la réponse part
// plutôt que par la route (06/11/2026, DECISIONS.md §131).
//
// Pourquoi : Next 16.4.5 (correctif GHSA-pc58-hwjq-p385) retire `content-length`, `content-encoding`
// et `transfer-encoding` de toute réponse de route (`next/dist/server/send-response.js`,
// `FORBIDDEN_HEADERS`) — parce qu'un corps relu par `fetch` a pu être décompressé en gardant ses
// en-têtes d'origine. Or le catalogue, les Nouveautés et les listes HLS partent déjà compressés : le
// 05/11/2026 le navigateur a reçu du brotli sans `Content-Encoding`, lu comme du JSON (« The string
// did not match the expected pattern »), et toute l'application est restée vide. Le gate était vert :
// aucun test ne passait par le vrai serveur de Next.
//
// Le mécanisme : la route ne dit plus `Content-Encoding` mais un marqueur interne (`x-cine-encoding`,
// `x-cine-length`), que Next laisse passer comme n'importe quel en-tête ; ce module, branché par
// boot.mjs sur chaque réponse avant que Next ne la voie, le change en vrai en-tête **à l'instant où
// Next le pose** (`setHeader` / `appendHeader`) — et non à `writeHead` : le module `compression` de
// Next (`router-server.js`) décide de compresser dans son propre `writeHead`, qui s'exécute *avant*
// le nôtre (il est installé après). Vu à cet instant, `Content-Encoding` lui fait dire « already
// encoded » : jamais de gzip par-dessus brotli. En pratique il ne compresse de toute façon aucune
// réponse de route (relevé le 06/11/2026 sur 16.4.3 et 16.4.5) : `sendResponse` pose les en-têtes en
// tableaux (`["application/json"]`) et son filtre `compressible` n'accepte qu'une chaîne — il ne
// compresse que les pages et les fichiers statiques. La règle tient quand même si cela change.
//
// Le fond de la faille GHSA-pc58 est une longueur déclarée qui ne correspond pas au corps envoyé (des
// octets en trop sont lus comme la réponse suivante). Une longueur n'est donc crue que comme un
// nombre entier, et le corps qui part est compté : un octet de trop ou un corps trop court ferme la
// connexion au lieu de finir la réponse. Les routes ne déclarent qu'une longueur qu'elles tiennent
// (corps en mémoire, fichier borné, longueur d'amont d'un corps que `fetch` n'a pas décodé) ; ce
// compte n'est que la ceinture.

/** Les marqueurs : jamais envoyés tels quels au client. Écrits en minuscules, comme Next les pose. */
export const ENCODING_MARKER = "x-cine-encoding";
export const LENGTH_MARKER = "x-cine-length";

/** Ce que boot.mjs écrit dans l'environnement, et que les routes lisent pour savoir si le marqueur sera traduit. */
export const FRAMING_ENV = "CINE_FRAMING_HEADERS";

/** Les seuls codages que les routes précompressent. Tout autre valeur est jetée, pas recopiée. */
const ENCODINGS = new Set(["br", "gzip"]);

/** Une longueur : des chiffres, et un entier sûr — `Number("1e3")` ou `" 12"` ne passent pas. */
const LENGTH = /^\d{1,15}$/;

function single(value) {
  // `appendHeader` de Next écrit un tableau (`NodeNextResponse.appendHeader`, base-http/node.js) :
  // une seule valeur est acceptée, deux valeurs différentes sont un marqueur illisible.
  if (Array.isArray(value)) return value.length === 1 ? String(value[0]) : null;
  if (typeof value === "string" || typeof value === "number") return String(value);
  return null;
}

/**
 * La traduction d'un en-tête posé par une route : `{ name, value }` pour un marqueur valide, `null`
 * pour un marqueur invalide (jeté), `undefined` pour un en-tête ordinaire (laissé tel quel).
 */
export function framingHeaderFor(name, value) {
  const lower = String(name).toLowerCase();
  if (lower === ENCODING_MARKER) {
    const v = single(value)?.trim().toLowerCase();
    return v && ENCODINGS.has(v) ? { name: "Content-Encoding", value: v } : null;
  }
  if (lower === LENGTH_MARKER) {
    const v = single(value)?.trim();
    return v && LENGTH.test(v) && Number.isSafeInteger(Number(v)) ? { name: "Content-Length", value: v } : null;
  }
  return undefined;
}

/** Un statut qui n'a jamais de corps (RFC 9110) : rien à compter. */
function bodyless(method, status) {
  return method === "HEAD" || status === 204 || status === 304 || (status >= 100 && status < 200);
}

function byteLength(chunk, encoding) {
  if (chunk == null) return 0;
  if (typeof chunk === "string") return Buffer.byteLength(chunk, typeof encoding === "string" ? encoding : "utf8");
  return chunk.byteLength ?? chunk.length ?? 0;
}

/**
 * Brancher le cadrage sur une réponse — à appeler sur l'événement `request`, avant Next.
 *
 * `setHeader` / `appendHeader` traduisent les marqueurs ; `writeHead` retire ceux qui y arriveraient
 * par un autre chemin (ses propres arguments) et arme le compte des octets si la longueur traduite
 * est encore là — `compression`, quand il compresse lui-même un corps, retire `Content-Length` et le
 * compte n'a alors plus d'objet ; `write` / `end` comptent ce qui part vraiment sur la connexion
 * (ils sont sous `compression`, qui les a capturés après nous).
 */
export function installResponseFraming(req, res) {
  const setHeader = res.setHeader;
  const appendHeader = res.appendHeader;
  const writeHead = res.writeHead;
  const write = res.write;
  const end = res.end;
  let declared = null; // la longueur traduite, en texte
  let budget = null; // armé à writeHead : octets encore permis
  let broken = false;

  res.setHeader = function (name, value) {
    const framed = framingHeaderFor(name, value);
    if (framed === undefined) return setHeader.call(this, name, value);
    if (framed === null) return this; // un marqueur illisible n'est ni traduit ni envoyé
    if (framed.name === "Content-Length") declared = framed.value;
    return setHeader.call(this, framed.name, framed.value);
  };

  if (typeof appendHeader === "function") {
    res.appendHeader = function (name, value) {
      const framed = framingHeaderFor(name, value);
      if (framed === undefined) return appendHeader.call(this, name, value);
      // Jamais ajouté à une valeur existante : un cadrage n'a qu'une valeur.
      return framed === null ? this : res.setHeader(name, value);
    };
  }

  res.writeHead = function (status, ...rest) {
    // Les en-têtes passés en argument : un marqueur arrivé là est jeté, jamais traduit — à cet
    // instant `compression` a déjà décidé, et traduire après lui pourrait étiqueter « br » un corps
    // qu'il vient de gzipper. Next ne passe pas par là (sendResponse pose tout par `appendHeader`).
    for (const arg of rest) {
      if (Array.isArray(arg)) {
        for (let i = arg.length - 2; i >= 0; i -= 2) {
          if (framingHeaderFor(arg[i], arg[i + 1]) !== undefined) arg.splice(i, 2);
        }
      } else if (arg && typeof arg === "object") {
        for (const key of Object.keys(arg)) if (framingHeaderFor(key, arg[key]) !== undefined) delete arg[key];
      }
    }
    this.removeHeader(ENCODING_MARKER);
    this.removeHeader(LENGTH_MARKER);
    const current = this.getHeader("content-length");
    budget =
      declared !== null && current !== undefined && String(current) === declared && !bodyless(req?.method, Number(status))
        ? Number(declared)
        : null;
    return writeHead.call(this, status, ...rest);
  };

  /** Un corps qui ne tient pas sa longueur : la connexion est coupée, la réponse jamais « finie ». */
  function cut(self, why) {
    broken = true;
    self.destroy(new Error(`[cadrage] ${why} (Content-Length ${declared})`));
  }

  res.write = function (chunk, encoding, cb) {
    if (broken) return false;
    if (!this.headersSent) this.writeHead(this.statusCode);
    if (budget !== null) {
      const n = byteLength(chunk, encoding);
      if (n > budget) {
        cut(this, "corps plus long que la longueur déclarée");
        return false;
      }
      budget -= n;
    }
    return write.call(this, chunk, encoding, cb);
  };

  res.end = function (chunk, encoding, cb) {
    if (broken) return this;
    if (budget !== null || (!this.headersSent && declared !== null)) {
      if (!this.headersSent) this.writeHead(this.statusCode);
      if (budget !== null) {
        const n = typeof chunk === "function" ? 0 : byteLength(chunk, encoding);
        if (n !== budget) {
          cut(this, n > budget ? "corps plus long que la longueur déclarée" : "corps plus court que la longueur déclarée");
          return this;
        }
        budget = 0;
      }
    }
    return end.call(this, chunk, encoding, cb);
  };
}
