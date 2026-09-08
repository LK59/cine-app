const { version } = require("./package.json");

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
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
    NEXT_PUBLIC_VAPID_PUBLIC_KEY: process.env.VAPID_PUBLIC_KEY ?? "",
    NEXT_PUBLIC_CLARA_GALLERY_ENABLED: process.env.CLARA_GALLERY_ENABLED ?? "true",
    NEXT_PUBLIC_APP_VERSION: version,
    // Ce qui distingue réellement deux builds. `version` vient de package.json et n'a pas bougé
    // depuis le premier jour : la ligne des réglages affichait « v1.0.0 » quel que soit le code
    // effectivement servi, donc ne répondait pas à la seule question qu'on lui pose. BUILD_REF
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
              // www.youtube.com : loadYoutubeIframeApi.ts:82 injecte <script src=…/iframe_api>.
              "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' https://www.youtube.com",
              // React écrit des attributs style= ; seul 'unsafe-inline' les couvre. Les polices
              // next/font sont auto-hébergées sous /_next/static, donc 'self'.
              "style-src 'self' 'unsafe-inline'",
              "font-src 'self'",
              // image.tmdb.org et artworks.thetvdb.com sont les hôtes de remotePatterns (F-009),
              // mais la CSP couvre en plus les <img> nus que l'optimiseur ne voyait pas :
              // img.youtube.com pour les vignettes de bande-annonce (person/[id]/page.tsx:282),
              // et le remotePoster de Radarr/Sonarr (radarr/page.tsx:434, sonarr/page.tsx:444),
              // qui retombe sur ces deux mêmes hôtes.
              // Volontairement sans data: ni blob: — rien dans le dépôt n'en sert en image, et
              // le parcours en Report-Only n'a relevé aucune violation ici, ce qui le confirme.
              "img-src 'self' https://image.tmdb.org https://artworks.thetvdb.com https://img.youtube.com",
              // blob: n'est pas une commodité : le lecteur natif attache son MediaSource par
              // URL.createObjectURL (mseSource.ts:240,244). Sans lui, plus aucun film ne démarre.
              "media-src 'self' blob:",
              // Les trois hôtes d'images et celui du script YouTube reparaissent ici, et ce
              // n'est pas une redondance avec img-src/script-src : le service worker hérite de
              // cette politique (elle est servie avec /sw.js), et son gestionnaire fetch
              // n'exclut que le *chemin* /api/ (sw.js:32). Toute image distante est donc
              // interceptée puis rejouée en fetch() (sw.js:87), et un fetch relève de
              // connect-src, pas d'img-src. Mesuré : ~2630 violations sur un parcours complet
              // en Report-Only, sans un seul fetch vers une URL absolue dans src/.
              //
              // 'self' couvre le reste : /api/sse (SSENotifier.tsx:91) et les GET par plages du
              // lecteur natif (byteSource.ts:185,235, en-tête Range sur /api/jellyfin/stream).
              "connect-src 'self' https://image.tmdb.org https://artworks.thetvdb.com https://img.youtube.com https://www.youtube.com",
              // Deux hôtes : youtube-nocookie pour TrailerModal.tsx:48, www.youtube.com pour la
              // carte vidéo de person/[id]/page.tsx:288 et pour les cadres que crée l'API iframe.
              "frame-src https://www.youtube-nocookie.com https://www.youtube.com",
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
    ];
  },
};

module.exports = nextConfig;
