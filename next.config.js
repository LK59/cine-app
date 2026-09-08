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
          // Phase 1 de F-010 : on observe, on ne bloque pas. `Report-Only` n'applique rien —
          // il fait seulement écrire la violation dans la console du navigateur. La bascule
          // vers `Content-Security-Policy` tout court est une décision séparée, à prendre
          // après avoir relevé ce que cette politique-ci signale en usage réel.
          //
          // Il n'y a pas de point de collecte (`report-to`) : les rapports restent locaux au
          // navigateur de qui teste.
          //
          // /!\ Connu d'avance : Next émet lui-même 7 scripts inline sans nonce par page
          // (la charge utile RSC, `self.__next_f.push`), mesurés sur /login. Ils violeront
          // `script-src` à chaque chargement tant qu'un nonce n'est pas posé dans proxy.ts.
          // Ce n'est pas une régression à corriger ici, c'est le bruit de fond à trier.
          {
            key: "Content-Security-Policy-Report-Only",
            value: [
              "default-src 'self'",
              // Le hash est celui du script d'accent de layout.tsx:84 (applique le thème avant
              // le premier rendu). Il est calculé sur le contenu exact du template : toute
              // retouche de cette ligne, espace compris, invalide le hash — et le symptôme
              // sera une violation, pas une page cassée, tant qu'on est en Report-Only.
              // www.youtube.com : loadYoutubeIframeApi.ts:82 injecte <script src=…/iframe_api>.
              "script-src 'self' 'sha256-+FwBETlEEYICBnpy7vxJRMMbjVkPRCLgbC/vWdl95Jo=' https://www.youtube.com",
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
              // c'est exactement ce que cette phase doit vérifier plutôt que présumer.
              "img-src 'self' https://image.tmdb.org https://artworks.thetvdb.com https://img.youtube.com",
              // blob: n'est pas une commodité : le lecteur natif attache son MediaSource par
              // URL.createObjectURL (mseSource.ts:240,244). Sans lui, plus aucun film ne démarre.
              "media-src 'self' blob:",
              // Tout ce que le client appelle est same-origin, y compris les GET par plages du
              // lecteur natif (byteSource.ts:185,235 posent un en-tête Range sur /api/jellyfin/stream).
              "connect-src 'self'",
              // Deux hôtes : youtube-nocookie pour TrailerModal.tsx:48, www.youtube.com pour la
              // carte vidéo de person/[id]/page.tsx:288 et pour les cadres que crée l'API iframe.
              "frame-src https://www.youtube-nocookie.com https://www.youtube.com",
              // blob: est obligatoire ici : hls.js construit son démultiplexeur depuis un Blob
              // (injectWorker, hls.js/dist/hls.js:15931) et PlayerHost.tsx ne désactive pas
              // enableWorker. 'self' couvre /sw.js.
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
