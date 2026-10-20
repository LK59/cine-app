import { NextRequest, NextResponse } from "next/server";
import { config } from "@/lib/config";
import { jellyfinAuthHeaders } from "@/lib/jellyfinAuth";
import { passJellyfinFetch } from "@/lib/jellyfinBreaker";
import { SESSION_COOKIE } from "@/lib/auth";
import { verifySessionFull } from "@/lib/session";
import { isJellyfinId, isStreamPath, isUnderJellyfinPrefix } from "@/lib/jellyfinPath";
import { castPassDetailsFor, castPreflightFor, withCastPass, CAST_TOKEN_PARAM, type CastPass } from "@/lib/castToken";
import { castProgressRelay } from "@/lib/castProgress";
import { castPreflightResponse, withCastCors } from "@/lib/castCors";
import { stripAccessToken } from "@/lib/stripAccessToken";
import { castMasterPlaylist } from "@/lib/castMaster";
import { fixVttTimestampMap } from "@/lib/vttTimestampMap";
import { assertVisible } from "@/lib/itemVisibility";
import { encodePlaylist } from "@/lib/playlistEncoding";
import { noteMediaRead } from "@/lib/repliques/playbackActivity";

// Root cause found live via temporary request logging: right after a fresh remux job starts
// (e.g. on an audio-track switch, which always requests a brand new PlaySessionId/ffmpeg job),
// the very first fetch for the HLS init segment (fmp4's EXT-X-MAP, hls1/main/-1.mp4) can race
// ffmpeg's own disk writes and come back as a transient 500 — Jellyfin returns the playlist text
// instantly (cheap to generate), but the actual segment files depend on real ffmpeg I/O that
// takes a brief moment to catch up. hls.js already retries a failed fragment load internally
// with backoff, silently absorbing this — which is exactly why Firefox never showed a problem.
// Safari's native (non-MSE) HLS pipeline does not retry a failed segment fetch anywhere near as
// forgivingly, especially for the foundational init segment: one transient 500 there was enough
// to make it give up on the whole source instantly (MediaError code 4, SRC_NOT_SUPPORTED) — not
// a WebKit element-reuse limitation after all (a genuinely fresh <video> element hit it just the
// same), a real server-timing race that Firefox was silently protecting us from all along.
const UPSTREAM_RETRY_DELAYS_MS = [200, 500, 1000];
const UPSTREAM_HEADERS_TIMEOUT_MS = 30_000;

async function fetchWithRetry(target: string, headers: Record<string, string>, signal: AbortSignal) {
  let res = await passJellyfinFetch(target, { signal, headers });
  for (const delay of UPSTREAM_RETRY_DELAYS_MS) {
    // 5xx only. The race above surfaces as a transient 500 from Jellyfin, and that is worth
    // waiting out. A 4xx is a definite answer — a segment past the end of a finished transcode
    // after a seek, a stale PlaySessionId — and retrying it just spends 1.7s of sleeps before
    // telling the browser something it could have known immediately.
    if (res.ok || res.status < 500) return res;
    // Le corps de la réponse écartée est lâché : sans cela, la connexion restait tenue jusqu'au
    // ramasse-miettes, une par nouvel essai (08/10/2026).
    await res.body?.cancel().catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, delay));
    res = await passJellyfinFetch(target, { signal, headers });
  }
  return res;
}

/**
 * Le laissez-passer d'un téléviseur ne repart pas vers Jellyfin (08/10/2026) : il ne lui sert à rien
 * et finissait dans ses journaux, en clair. La chaîne n'est réécrite que s'il est là — sinon elle part
 * telle quelle, octet pour octet.
 */
function withoutCastToken(search: string): string {
  const params = new URLSearchParams(search);
  if (!params.has(CAST_TOKEN_PARAM)) return search;
  params.delete(CAST_TOKEN_PARAM);
  const rest = params.toString();
  return rest ? `?${rest}` : "";
}

type StreamParams = { params: Promise<{ itemId: string; path: string[] }> };

/**
 * Le laissez-passer est vérifié une fois, ici, avant tout le reste : il décide de l'accès sans
 * cookie (plus bas) et des en-têtes CORS de la réponse, quelle qu'elle soit — un refus lisible par
 * le récepteur Chromecast vaut mieux qu'une réponse qu'il jette (DECISIONS.md §64, `castCors.ts`).
 * Sans laissez-passer, la réponse sort exactement telle qu'avant.
 */
export async function GET(req: NextRequest, context: StreamParams) {
  const pass = await castPassDetailsFor(req);
  const res = await serveStream(req, context, pass);
  // CORS pour un téléviseur seulement : le lecteur serveur de la page charge aussi l'adresse signée,
  // mais avec son cookie, et garde ses en-têtes d'avant (chasse aux bugs du 11/10/2026).
  return pass && !req.cookies.get(SESSION_COOKIE) ? withCastCors(res) : res;
}

/**
 * La question préalable du récepteur Chromecast, pour une adresse munie de son laissez-passer.
 * Sans lui, refusée : rien d'autre que ce titre, en lecture, ne s'ouvre à un autre domaine.
 */
export async function OPTIONS(req: NextRequest, { params }: StreamParams) {
  const { itemId, path } = await params;
  if (!isJellyfinId(itemId) || !isStreamPath(path)) return new NextResponse(null, { status: 400 });
  if (!(await castPreflightFor(req))) return new NextResponse(null, { status: 403 });
  return castPreflightResponse();
}

async function serveStream(req: NextRequest, { params }: StreamParams, pass: CastPass | null) {
  const castPass = pass?.user ?? null;
  if (!config.player.enabled) return new NextResponse(null, { status: 404 });
  const receivedAt = performance.now();

  const { itemId, path } = await params;
  if (!isJellyfinId(itemId)) return new NextResponse(null, { status: 400 });
  // Avant toute concaténation : un segment attrape-tout peut porter un `/` (un `%2F` décodé par
  // Next) et `path.join("/")` reconstituerait alors la traversée, quelle que soit l'étape où le
  // décodage a eu lieu. Refusé ici, la chaîne n'est jamais assemblée.
  if (!isStreamPath(path)) return new NextResponse(null, { status: 400 });

  // Un téléviseur en diffusion n'a pas de cookie : son laissez-passer répond à sa place. Même
  // fonction que le proxy, jamais une seconde formulation — voir `castPassFor` (posée par `GET`).
  if (!castPass) {
    const token = req.cookies.get(SESSION_COOKIE)?.value;
    const session = await verifySessionFull(token);
    if (!session?.jfId) return new NextResponse(null, { status: 403 });
    // La clé d'administration signe l'appel ci-dessous et voit tout : le droit du compte sur ce
    // titre est demandé à Jellyfin d'abord, une fois par séance — voir `assertVisible`. Le
    // laissez-passer de diffusion n'y passe pas (il ne porte pas le `jfId`, voir là-bas).
    const refused = await assertVisible(session, itemId);
    if (refused) return refused;
  }

  // Des octets d'un film partent : l'indexation des répliques se tait (DECISIONS.md §88).
  noteMediaRead();

  const restPath = path.join("/");
  // Le jeton d'une adresse ancienne ou recopiée ne repart pas : l'en-tête ci-dessous authentifie
  // la requête, et Jellyfin le lit avant la requête — voir `stripAccessToken`.
  const target = `${config.jellyfin.url}/videos/${itemId}/${restPath}${stripAccessToken(withoutCastToken(req.nextUrl.search))}`;
  // Ceinture et bretelles : la question est reposée sur l'URL assemblée, celle que `fetch`
  // normalisera, et non sur les morceaux dont elle sort.
  if (!isUnderJellyfinPrefix(target, `${config.jellyfin.url}/videos/${itemId}/`)) {
    return new NextResponse(null, { status: 400 });
  }

  const isStatic = req.nextUrl.searchParams.get("static") === "true";
  /**
   * Les décisions sur le chemin se prennent sans la casse (20/10/2026, revue de sécurité) : les routes
   * de Jellyfin n'y sont pas sensibles. `SUBTITLES.M3U8` échappait au test `.m3u8`, partait par la
   * branche des segments, tel quel — et la liste de sous-titres que Jellyfin y écrit porte, dans
   * chaque adresse, la clé d'administration avec laquelle ce relais l'interroge. N'importe quel
   * compte, un invité de lien, un téléviseur la recevaient en clair.
   */
  const lowerPath = restPath.toLowerCase();
  const isManifest = lowerPath.endsWith(".m3u8");

  try {
    // Root cause found live: Safari issues a speculative byte-Range request for the manifest
    // itself on a second load of the same path (e.g. an audio-track switch) — never seen on a
    // first load. Forwarding that Range to Jellyfin got back a 206 Partial Content (only the
    // first ~1.4KB), which we then handed to the browser under a plain 200 with no Content-Range
    // — a manifest silently truncated mid-line, not the full playlist it claimed to be. Safari's
    // native HLS parser can't make sense of that and rejects the whole source outright
    // (MediaError code 4, SRC_NOT_SUPPORTED) — instantly, no network delay needed to explain it.
    // We always need the complete manifest text anyway (for the URL-rewrite below), so Range is
    // simply never forwarded for this case — Jellyfin always returns the full playlist, we always
    // send the browser the full rewritten text back with a plain 200, which is a perfectly valid
    // response to a Range request under HTTP (the client falls back to using the whole body).
    const range = isManifest ? null : req.headers.get("range");
    const upstreamAt = performance.now();
    // Le délai borne l'attente de la réponse de Jellyfin, pas le transfert : un signal de
    // délai passé à `fetch` couvre aussi la lecture du corps, et coupait net au bout de 30 s
    // un segment du lecteur serveur ou une plage lue lentement par un téléphone en itinérance.
    // Une fois les en-têtes là, seul le départ du navigateur (`req.signal`) arrête le flux.
    const headerWait = new AbortController();
    const headerTimer = setTimeout(
      () => headerWait.abort(new DOMException("Jellyfin n'a pas répondu", "TimeoutError")),
      UPSTREAM_HEADERS_TIMEOUT_MS
    );
    let res: Response;
    try {
      res = await fetchWithRetry(
        target,
        // Only DirectPlay/DirectStream's static file endpoint is Range-seekable — forwarding it
        // here is what lets the browser's native <video> seeking issue real HTTP range requests
        // instead of always re-fetching from byte 0.
        { ...jellyfinAuthHeaders(config.jellyfin.apiKey), ...(range ? { Range: range } : {}) },
        AbortSignal.any([req.signal, headerWait.signal])
      );
    } finally {
      clearTimeout(headerTimer);
    }
    if (!res.ok || !res.body) {
      // The one log kept from the debugging era: an upstream failure that survived the retry
      // budget is a genuine ops signal (Jellyfin down, dead session), and it's low-volume.
      console.warn("[stream proxy] upstream failed after retries", restPath, res.status);
      return new NextResponse(null, { status: res.status || 502 });
    }

    const contentType = res.headers.get("Content-Type") ?? "application/octet-stream";

    /**
     * Second verrou, indépendant du chemin : un texte venu de Jellyfin ne repart jamais tel quel.
     * Une liste, des sous-titres, un message d'erreur peuvent recopier la clé d'administration de la
     * requête ; ce qui n'est ni la liste ni un segment de sous-titres traités plus bas est lu en
     * entier et nettoyé ici — même avec `static=true`. Les octets d'un film (vidéo, son, flux brut)
     * ne sont jamais du texte et passent sans être lus.
     */
    if (!isManifest && !lowerPath.endsWith(".vtt") && isTextual(contentType)) {
      const buf = Buffer.from(withoutAdminKey(stripAccessToken(await res.text())), "utf-8");
      return new NextResponse(buf, { headers: { "Content-Type": contentType, "Cache-Control": "no-store", "Content-Length": String(buf.length) } });
    }

    if (isManifest) {
      // HLS playlists can reference sibling segments/variant playlists with an
      // absolute "/videos/{itemId}/..." path (rather than one relative to this
      // manifest's own URL) — rewrite those back through our own proxy so the
      // browser never needs to know Jellyfin's real host.
      const text = await res.text();
      // Et sans jeton : Jellyfin recopie la requête du maître dans chaque variante et chaque
      // segment, et peut écrire le sien dans une piste de sous-titres — voir `stripAccessToken`.
      const rewritten = stripAccessToken(
        text.replace(
          new RegExp(`(?:https?:\\/\\/[^/\\s"]+)?\\/videos\\/${itemId}\\/`, "gi"),
          `/api/jellyfin/stream/${itemId}/`
        )
      );
      /**
       * Le laissez-passer est reporté dans chaque adresse que le manifeste désigne.
       *
       * Sans cela, la diffusion s'arrêterait après deux secondes : le téléviseur obtiendrait le
       * manifeste — la seule adresse que nous lui avons donnée — puis demanderait des centaines de
       * segments sans jeton, tous refusés. Ces adresses sont fabriquées juste au-dessus, donc
       * c'est ici, et nulle part ailleurs, qu'elles peuvent le recevoir.
       *
       * Ajouté seulement quand la requête en cours en portait un : une lecture normale, dans la
       * page et avec son cookie, ne doit pas se mettre à distribuer des laissez-passer.
       */
      // En diffusion, le maître perd ses variantes de secours — voir `castMasterPlaylist`.
      const withPass = castPass
        ? withCastPass(castMasterPlaylist(rewritten), itemId, req.nextUrl.searchParams.get(CAST_TOKEN_PARAM) ?? "")
        : rewritten;
      const buf = Buffer.from(withoutAdminKey(withPass), "utf-8");

      // Playlists are ALWAYS served whole, with Range requests deliberately ignored (a plain 200
      // full-body response is a valid answer to a Range request) and NO Accept-Ranges header.
      // A previous revision did the opposite — advertised "Accept-Ranges: bytes" and honored
      // Range with an honest 206 slice — and that combination was the actual root cause of a
      // long-hunted Safari/iOS failure: advertising byte-range support on the manifest is what
      // invited WebKit to re-request it as "Range: bytes=0-1445" at all, and the honest slice
      // then handed its HLS parser a playlist cut off mid-line. Per the HLS spec, playlists must
      // be delivered complete — clients are not expected to reassemble a playlist from partial
      // responses — so WebKit treated the truncated text as the whole playlist and rejected the
      // source outright (MediaError code 4, SRC_NOT_SUPPORTED). Any master playlist larger than
      // that ~1.4KB probe window (e.g. a Dolby Vision file's multi-variant master, ~3.5KB) hit
      // this on every load; smaller masters slipped through because the "slice" happened to
      // contain the full text.
      //
      // Compressée quand le client l'accepte (12/10/2026) : la liste d'un épisode pesait 954 Ko en
      // clair, et sur une connexion lente le lecteur serveur ne démarrait jamais — voir
      // `encodePlaylist`. Le texte ci-dessus n'en est pas changé d'un octet.
      const encoded = await encodePlaylist(buf, req.headers.get("accept-encoding"));
      return new NextResponse(new Uint8Array(encoded.body), {
        headers: { "Content-Type": contentType, "Cache-Control": "no-store", ...encoded.headers },
      });
    }

    // Un segment de sous-titres HLS : lu en entier (quelques centaines d'octets) pour corriger le
    // repère de temps que Jellyfin y écrit pour des segments `.ts` — voir `fixVttTimestampMap`.
    if (lowerPath.endsWith(".vtt")) {
      const buf = Buffer.from(withoutAdminKey(fixVttTimestampMap(await res.text())), "utf-8");
      return new NextResponse(buf, {
        headers: { "Content-Type": contentType, "Cache-Control": "private, max-age=21600", "Content-Length": String(buf.length) },
      });
    }

    if (isStatic) {
      // DirectPlay/DirectStream: a single big Range-seekable file, not an immutable HLS
      // segment — pass through the real status (200 or 206) and range headers as-is instead
      // of assuming 200, so native <video> seeking works.
      // `private` : la réponse n'est servie qu'à une session ou à un laissez-passer, et aucun cache
      // partagé — relais inverse, proxy d'entreprise — ne doit la resservir à qui n'en a pas
      // (chasse aux défauts du 25/09/2026).
      // `no-store` (28/09/2026) : pas même le cache du navigateur. Gardées (`max-age`), ces plages
      // pouvaient toutes être écrites dans son cache sur disque — Chromium garde les réponses
      // partielles, par blocs — soit à peu près la taille de ce qu'on regarde, en écritures sur la
      // mémoire flash, pour rien : le lecteur a sa propre mémoire (`HttpByteSource`, sa réserve) et la
      // reprise sa copie sur l'appareil (`src/lib/resumeCache/`). La même raison qui a retiré la réserve
      // d'avance du disque le même jour.
      const passthroughHeaders: Record<string, string> = { "Content-Type": contentType, "Cache-Control": "private, no-store" };
      const contentRange = res.headers.get("Content-Range");
      const contentLength = res.headers.get("Content-Length");
      const acceptRanges = res.headers.get("Accept-Ranges");
      if (contentRange) passthroughHeaders["Content-Range"] = contentRange;
      if (contentLength) passthroughHeaders["Content-Length"] = contentLength;
      if (acceptRanges) passthroughHeaders["Accept-Ranges"] = acceptRanges;
      // La date du fichier chez Jellyfin (25/09/2026) : les octets gardés sur l'appareil pour une
      // reprise instantanée ne valent que pour ce fichier-là, et un fichier remplacé (réencodé par
      // son gestionnaire) en change — voir `src/lib/resumeCache/`.
      const lastModified = res.headers.get("Last-Modified");
      if (lastModified) passthroughHeaders["Last-Modified"] = lastModified;
      // Ce que le serveur a coûté à cette plage, lisible par le lecteur (22/09/2026) : des sauts de
      // dix secondes depuis un serveur lointain, et rien pour dire si c'était le trajet, ce relais
      // ou Jellyfin. `app` : de la réception de la requête aux en-têtes de Jellyfin ; `jf` : Jellyfin
      // seul. Le reste du délai que le navigateur mesure est le trajet.
      const now = performance.now();
      passthroughHeaders["Server-Timing"] = `app;dur=${Math.round(now - receivedAt)}, jf;dur=${Math.round(now - upstreamAt)}`;
      return new NextResponse(res.body, { status: res.status, headers: passthroughHeaders });
    }

    // Each HLS segment URL is tied to a specific PlaySessionId and never changes
    // content once generated — immutable, and long-lived enough to cover a
    // full movie, so a rewind past hls.js's in-memory buffer replays from the
    // browser's HTTP cache instead of re-hitting Jellyfin. `private`, like the file above: only the
    // browser's cache may keep it.
    //
    // Un segment demandé par un téléviseur : sa position est notée, et rapportée à Jellyfin si la
    // page qui a lancé la diffusion s'est tue (`castProgress.ts`, DECISIONS.md §64). Seulement avec
    // un laissez-passer, et seulement pour un téléviseur : le lecteur serveur de la page charge lui
    // aussi l'adresse signée (`castUrl`), mais il porte le cookie de session — un récepteur AirPlay ou
    // Chromecast n'en a jamais. Sans ce filtre, toute lecture serveur en pause était « relayée »
    // (chasse aux bugs du 11/10/2026).
    if (pass && !req.cookies.get(SESSION_COOKIE)) castProgressRelay().noteCastSegment({ jfId: pass.jfId, user: pass.user, itemId, restPath, search: req.nextUrl.searchParams });
    return new NextResponse(res.body, {
      headers: { "Content-Type": contentType, "Cache-Control": "private, max-age=21600, immutable" },
    });
  } catch {
    return new NextResponse(null, { status: 502 });
  }
}

/** Un corps que Jellyfin écrit en texte — liste HLS, sous-titres, JSON, message d'erreur. */
function isTextual(contentType: string): boolean {
  return /mpegurl|^text\/|json|xml|javascript/i.test(contentType);
}

/**
 * La clé d'administration, retirée où qu'elle soit écrite et sous quelque nom de paramètre : le
 * nettoyage des paramètres (`stripAccessToken`) ne connaît que ceux qu'il nomme.
 */
function withoutAdminKey(text: string): string {
  const key = config.jellyfin.apiKey;
  return key ? text.split(key).join("") : text;
}

