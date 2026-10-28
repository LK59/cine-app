const { version } = require("./package.json");

/**
 * Le kit d'émission Chromecast, au chemin près et non tout www.gstatic.com (11/10/2026) : l'hôte sert
 * bien d'autres scripts de Google, qu'aucune page d'ici n'a à charger. Relevé par curl sur le kit
 * lui-même : `cv/js/sender/v1/cast_sender.js` (ce que charge `src/lib/chromecast/framework.ts`)
 * charge `cast/sdk/libs/sender/1.0/cast_framework.js`, et sur Chrome Android
 * `eureka/clank/cast_sender.js`. Le reste passe par l'extension intégrée de Chrome
 * (`chrome-extension://…`), que la CSP d'une page ne bloque pas. Un chemin finissant par « / » est un
 * préfixe en CSP.
 */
const CAST_KIT_SOURCES = [
  "https://www.gstatic.com/cv/js/sender/",
  "https://www.gstatic.com/cast/sdk/libs/sender/",
  "https://www.gstatic.com/eureka/clank/",
].join(" ");

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Pas de `x-powered-by: Next.js` : rien à gagner à annoncer la pile à qui sonde le site.
  poweredByHeader: false,
  output: "standalone",
  // Pas de `experimental.proxyClientMaxBodySize` : la limite reste celle de Next (10 Mo). Dès qu'un
  // proxy existe, Next garde en mémoire jusqu'à cette limite le corps de chaque requête qu'il
  // couvre, avant que le proxy n'ait rien décidé. Portée à 100 Mo pour les captures des
  // signalements, elle valait pour toute l'API, anonymes compris : vingt POST de 95 Mo sans cookie
  // remplissaient les 2 Go du conteneur (audit A2, 29/09/2026). Les signalements sont sortis du
  // proxy à la place (`HORS_PROXY`, src/proxy.ts) ; un test tient cette limite au défaut.
  // Lets the development stack compile into its own directory (see docker-compose.dev.yml), so a
  // `next dev` running against the working tree and a production image build never overwrite each
  // other's output.
  ...(process.env.NEXT_DIST_DIR ? { distDir: process.env.NEXT_DIST_DIR } : {}),
  reactStrictMode: true,
  // sharp is externalized by Next.js by default; web-push needs to be added explicitly.
  serverExternalPackages: ["web-push"],
  images: {
    // Les deux seuls hôtes distants réellement servis en image, relevés dans le dépôt plutôt que
    // devinés (F-009). `hostname: "**"` faisait de /_next/image un relais ouvert et sans session
    // vers n'importe quelle image du web, ré-encodée par sharp puis conservée un an sur ./data.
    //
    // artworks.thetvdb.com n'est pas une hypothèse : posterUrl()/backdropUrl() (src/lib/images.ts)
    // renvoient le `remoteUrl` de Radarr/Sonarr, et mesuré en direct sur cette bibliothèque les
    // 134 séries de Sonarr y ont 100 % de leurs affiches — Radarr, lui, est entièrement sur TMDB.
    // L'oublier viderait toute la grille séries. Le préfixe de chemin est relevé de la même façon.
    remotePatterns: [
      { protocol: "https", hostname: "image.tmdb.org", pathname: "/t/p/**" },
      { protocol: "https", hostname: "artworks.thetvdb.com", pathname: "/banners/**" },
    ],
    // Next.js 16 defaults local image patterns to an empty query string;
    // our Jellyfin image proxy passes itemId/tag as query params.
    localPatterns: [{ pathname: "/api/jellyfin/image" }],
    // Every image the optimizer produces is written under .next/cache/images and re-served from
    // there — but only until its TTL expires, which defaults to 60s. On a self-hosted box that
    // means the server re-encodes the same posters all day long (and, on the Cinema grid, several
    // hundred of them at once while scrolling). Poster/backdrop URLs are content-addressed
    // upstream, so a new artwork is a new URL, never a stale cache entry: a year is safe.
    minimumCacheTTL: 31536000,
  },
  env: {
    // La version livrée, choisie à la main dans package.json avant chaque déploiement (majeur,
    // mineur, correctif) : lue par `APP_VERSION` (src/lib/appBuild.ts), affichée façon iOS,
    // annoncée à Jellyfin et écrite au journal du lecteur à côté du build.
    NEXT_PUBLIC_APP_VERSION: version,
    // Ce qui distingue réellement deux builds. La version ne bouge qu'aux livraisons : deux
    // builds d'une même version ne se distinguent que par celui-ci. BUILD_REF
    // est passé par le Dockerfile (le hash court du commit quand on le lui donne) ; à défaut,
    // l'horodatage du build, qui change lui aussi à chaque fois.
    NEXT_PUBLIC_APP_BUILD:
      process.env.BUILD_REF || new Date().toISOString().slice(0, 16).replace("T", " ") + " UTC",
  },
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
          { key: "X-DNS-Prefetch-Control", value: "on" },
          { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
          // F-010, phase 2 : la politique bloque désormais. Elle a d'abord tourné en
          // `Report-Only` le temps d'un parcours complet ; ce qui suit porte les trois seuls
          // ajustements que ce parcours a imposés, chacun commenté à sa directive.
          //
          // Ce qu'elle protège, et ce qu'elle ne protège pas. `script-src` porte
          // `'unsafe-inline'` (voir plus bas) : contre l'injection d'un <script> inline, elle ne
          // vaut rien. Ce qui reste, et qui est l'essentiel du filet visé par F-010 : un script
          // compromis ne peut plus exfiltrer vers un hôte de son choix (`connect-src`), la page
          // ne peut pas être encadrée (`frame-ancestors`), ni sa base ni ses formulaires
          // détournés (`base-uri`, `form-action`), ni un plugin chargé (`object-src`).
          //
          // Pas de `report-to` : plus rien n'est collecté une fois la phase d'observation close.
          {
            key: "Content-Security-Policy",
            value: [
              "default-src 'self'",
              // `'unsafe-inline'`, et donc PAS de hash — décision prise, pas un oubli. Next
              // émet 7 scripts inline sans nonce par page (la charge utile RSC,
              // `self.__next_f.push`, mesurés sur /login) ; les autoriser demanderait un nonce
              // par requête posé dans proxy.ts et relayé dans layout.tsx. Attention au piège
              // qui va avec : un hash ou un nonce présent fait *ignorer* `'unsafe-inline'` par
              // les navigateurs CSP3. On ne peut donc pas garder le hash du script d'accent
              // (layout.tsx:84) « au cas où » — sa seule présence casserait les 7 autres.
              //
              // `'wasm-unsafe-eval'` et non `'unsafe-eval'` : les décodeurs AC-3 et DTS de
              // mediabunny (@mediabunny/ac3, @mediabunny/dts, chargés en import dynamique par
              // webcodecs/softwareAudio.ts:42-46) sont des portages Emscripten qui appellent
              // WebAssembly.instantiate. Ils servent 72 % de cette bibliothèque et sur le
              // chemin natif, pas seulement sur le repli — sans eux, un film joue sans son.
              // Le mot-clé CSP3 autorise WebAssembly *sans* rouvrir eval().
              //
              // Aucun hôte YouTube depuis le 13/10/2026 : l'API iframe (bande-annonce de fond) a été
              // retirée ; la seule vidéo YouTube restante est le cadre de TrailerModal (frame-src).
              //
              // www.gstatic.com : le kit d'émission Chromecast (`src/lib/chromecast/framework.ts`,
              // DECISIONS.md §64), chargé seulement là où une diffusion est possible ; il charge
              // lui-même son module (`cast_framework.js`) depuis le même hôte — chemins dans `CAST_KIT_SOURCES`.
              "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' " + CAST_KIT_SOURCES,
              // React écrit des attributs style= ; seul 'unsafe-inline' les couvre. Les polices
              // next/font sont auto-hébergées sous /_next/static, donc 'self'.
              "style-src 'self' 'unsafe-inline'",
              "font-src 'self'",
              // image.tmdb.org et artworks.thetvdb.com sont les hôtes de remotePatterns (F-009),
              // mais la CSP couvre en plus les <img> nus que l'optimiseur ne voyait pas : le
              // remotePoster de Radarr/Sonarr (radarr/page.tsx:434, sonarr/page.tsx:444), qui
              // retombe sur ces deux mêmes hôtes. (img.youtube.com retiré le 13/10/2026 : plus
              // aucune vignette de bande-annonce n'est affichée.)
              // blob: depuis le 24/09/2026, et pour une seule chose : l'aperçu des captures jointes
              // à un signalement, lu dans le fichier choisi (URL.createObjectURL) avant tout envoi.
              // Toujours sans data: — rien dans le dépôt n'en sert en image.
              "img-src 'self' blob: https://image.tmdb.org https://artworks.thetvdb.com",
              // blob: n'est pas une commodité : le lecteur natif attache son MediaSource par
              // URL.createObjectURL (mseSource.ts:240,244). Sans lui, plus aucun film ne démarre.
              "media-src 'self' blob:",
              // Les hôtes d'images reparaissent ici, et ce n'est pas une redondance avec img-src :
              // le service worker hérite de cette politique (elle est servie avec /sw.js), et son gestionnaire fetch
              // n'exclut que le *chemin* /api/ (sw.js:32). Toute image distante est donc
              // interceptée puis rejouée en fetch() (sw.js:87), et un fetch relève de
              // connect-src, pas d'img-src. Mesuré : ~2630 violations sur un parcours complet
              // en Report-Only, sans un seul fetch vers une URL absolue dans src/.
              //
              // 'self' couvre le reste : /api/sse (SSENotifier.tsx:91) et les GET par plages du
              // lecteur natif (byteSource.ts:185,235, en-tête Range sur /api/jellyfin/stream).
              // www.gstatic.com pour la même raison : le service worker rejoue en fetch() le script du
              // kit Chromecast qu'il intercepte.
              "connect-src 'self' https://image.tmdb.org https://artworks.thetvdb.com " + CAST_KIT_SOURCES,
              // Un seul hôte : le cadre de TrailerModal.tsx, la fenêtre du bouton « Bande-annonce »
              // des fiches — le seul usage de YouTube que l'application garde (13/10/2026). Les
              // cadres que créait l'API iframe (bande-annonce de fond) sont partis avec elle ; seuls
              // les cadres que notre page crée relèvent d'ici, pas ceux que l'embed ouvre lui-même.
              // Vérifié : l'embed youtube-nocookie répond 200, sans redirection vers www.youtube.com.
              "frame-src https://www.youtube-nocookie.com",
              // blob: est obligatoire ici, et pour deux raisons plutôt qu'une : hls.js
              // construit son démultiplexeur depuis un Blob (injectWorker,
              // hls.js/dist/hls.js:15931, et PlayerHost.tsx ne désactive pas enableWorker), et
              // les décodeurs mediabunny font de même pour le leur. 'self' couvre /sw.js.
              "worker-src 'self' blob:",
              "object-src 'none'",
              // Même verrou que le X-Frame-Options: DENY posé plus haut.
              "frame-ancestors 'none'",
              "base-uri 'self'",
              "form-action 'self'",
            ].join("; "),
          },
        ],
      },
      {
        // La page des livres (option, DECISIONS.md §127), et elle seule : la politique générale n'y est
        // pas élargie, elle y est remplacée (la dernière règle qui pose un en-tête l'emporte). Le lecteur
        // affiche chaque chapitre dans un cadre `blob:` (foliate-js) — d'où `frame-src blob:` — et un
        // document `blob:` hérite de la politique de la page qui l'a créé : c'est donc aussi celle des
        // livres. Elle ferme ce qu'un EPUB pourrait vouloir charger : aucune image, police, feuille de
        // style ni connexion hors de l'application (les ressources du livre sont des `blob:`), aucun
        // script venu d'un `blob:`. Les scripts du livre ne s'exécutent de toute façon pas : le cadre n'a
        // pas `allow-scripts` (`src/lib/books/foliate/README.md`), et le contenu est nettoyé avant
        // (`src/lib/books/sanitize.ts`). `'unsafe-inline'` reste pour les scripts de Next, comme ailleurs.
        // On n'y arrive que par un vrai chargement de page (liens ordinaires de `BooksMode` et `BooksHome`) : une
        // navigation côté client garderait le document de l'accueil, et sa politique.
        source: "/livres",
        headers: [
          {
            key: "Content-Security-Policy",
            value: [
              "default-src 'self'",
              "script-src 'self' 'unsafe-inline'",
              "style-src 'self' 'unsafe-inline' blob:",
              "font-src 'self' blob: data:",
              "img-src 'self' blob: data:",
              "media-src 'self' blob:",
              "connect-src 'self'",
              "frame-src blob:",
              "child-src blob:",
              "worker-src 'self'",
              "object-src 'none'",
              // `'self'` et non `'none'` : les chapitres `blob:` héritent aussi de cette directive, et
              // WebKit l'applique à leur propre cadre — avec `'none'`, il refusait d'afficher le moindre
              // chapitre (vérifié le 28/10/2026). La page reste inencadrable par tout autre site.
              "frame-ancestors 'self'",
              "base-uri 'self'",
              "form-action 'none'",
            ].join("; "),
          },
        ],
      },
      {
        // Les captures jointes à un signalement, et surtout leurs originaux, envoyés par n'importe
        // quel compte et ouverts dans la session de l'administrateur. Placée après la règle
        // générale, cette politique la remplace (la dernière règle qui pose un en-tête l'emporte) :
        // celle que la route posait elle-même était écrasée par la générale (vérifié en
        // production le 24/09/2026). Un fichier ouvert seul n'y exécute rien.
        source: "/api/reports/:id/images/:imageId",
        headers: [{ key: "Content-Security-Policy", value: "sandbox; default-src 'none'; img-src 'self'" }],
      },
    ];
  },
};

module.exports = nextConfig;
