"use client";

import { useState } from "react";
import Image from "next/image";

interface PosterImageProps {
  src: string | null | undefined;
  alt: string;
  className?: string;
  aspectRatio?: string;
  // Next's image optimizer proxies local images through an internal request that
  // doesn't forward cookies, so auth-gated routes (e.g. /api/jellyfin/image) 404/400
  // there. Skip optimization for those and let the browser fetch it directly.
  //
  // Déduit de l'adresse plutôt que laissé à l'appelant : une image servie par une route de
  // cette app est authentifiée par construction, donc jamais optimisable. L'oubli de ce drapeau
  // en déplaçant une carte a suffi à vider « Continuer à regarder » de toutes ses images — un
  // drapeau qu'il faut penser à porter est un drapeau qui finit par tomber.
  unoptimized?: boolean;
  // A calm static placeholder instead of the shared shimmer animation — opt-in, default
  // behavior everywhere else unchanged. Cinema Mode's rows can have a dozen+ small cards
  // loading at once; that many shimmers moving in sync reads as busy at that scale, where a
  // single flat tone doesn't.
  subtle?: boolean;
  // Overrides the default responsive `sizes` hint. The default is tuned for this app's main
  // poster grids (2-6 columns of a full-width layout); Cinema Mode's rows are far denser — a
  // card there is at most 144px wide, so the default's 20vw makes Next serve a ~384px image for
  // it, several times more pixels than the slot can show, on hundreds of cards at once.
  sizes?: string;
  // Opts a specific image out of lazy-loading — for the one image that's the point of the screen
  // (a hero), where waiting for the intersection observer is a visible delay.
  priority?: boolean;
}

/**
 * Dire quel hôte vient d'échouer, une fois par hôte.
 *
 * L'échec d'une image distante est muet ici par construction : `onError` bascule sur « No image »
 * et c'est tout ce que quiconque en voit — pas d'URL, pas de raison, rien dans la console. Or
 * `next.config.js` (`images.remotePatterns`, et la directive `img-src` de la CSP juste en dessous)
 * n'autorise que deux hôtes, tandis que `tmdbResize` (`src/lib/images.ts`) rend telle quelle
 * n'importe quelle adresse venue du `remoteUrl` de Radarr/Sonarr : un troisième hôte est donc
 * parfaitement possible, et il se présente exactement comme une affiche manquante. Un 400 de
 * l'optimiseur et une image réellement absente sont alors le même carré gris.
 *
 * La liste des hôtes autorisés n'est **pas** recopiée ici — elle vit dans `next.config.js`, et une
 * seconde copie dériverait. On ne prétend donc pas savoir *pourquoi* le chargement a échoué : on
 * nomme l'hôte et on dit où aller vérifier. C'est ce qui manquait pour faire le lien.
 *
 * Une grille en porte des centaines : la déduplication par hôte est ce qui distingue un
 * diagnostic d'un bruit de fond.
 */
const reportedImageHosts = new Set<string>();
function reportRemoteImageFailure(src: string): void {
  // Une image servie par cette app n'a rien à voir avec les hôtes distants : un échec là est un
  // 404 ou une session, pas une question de configuration.
  if (!/^https?:\/\//i.test(src)) return;
  let host: string;
  try {
    host = new URL(src).host;
  } catch {
    return;
  }
  if (reportedImageHosts.has(host)) return;
  reportedImageHosts.add(host);
  console.warn(
    `[image] échec de chargement depuis ${host} — si cet hôte n'est ni dans images.remotePatterns ` +
      `ni dans la directive img-src de la CSP (next.config.js), il est refusé avant d'être demandé.`,
    src
  );
}

export function PosterImage({
  src,
  alt,
  className = "",
  aspectRatio = "aspect-2/3",
  unoptimized = false,
  subtle = false,
  sizes = "(max-width: 640px) 50vw, (max-width: 1024px) 33vw, 20vw",
  priority = false,
}: PosterImageProps) {
  const [loaded, setLoaded] = useState(false);
  const [errored, setErrored] = useState(false);
  const skipOptimizer = unoptimized || (typeof src === "string" && src.startsWith("/api/"));

  if (!src || errored) {
    return (
      <div className={`${aspectRatio} ${className} flex items-center justify-center bg-slate-800/60`}>
        <div className="text-slate-600 text-xs text-center px-2">No image</div>
      </div>
    );
  }

  return (
    <div className={`${aspectRatio} ${className} relative overflow-hidden`}>
      {!loaded && <div className={`absolute inset-0 ${subtle ? "bg-slate-800/50" : "skeleton"}`} />}
      <Image
        src={src}
        alt={alt}
        fill
        unoptimized={skipOptimizer}
        sizes={sizes}
        priority={priority}
        className={`object-cover transition-opacity duration-500 ${loaded ? "opacity-100" : "opacity-0"}`}
        onLoad={() => setLoaded(true)}
        onError={() => {
          reportRemoteImageFailure(src);
          setErrored(true);
        }}
      />
    </div>
  );
}

interface BackdropImageProps {
  src: string | null | undefined;
  alt?: string;
  className?: string;
}

export function BackdropImage({ src, alt = "", className = "" }: BackdropImageProps) {
  const [loaded, setLoaded] = useState(false);

  return (
    <div className={`relative overflow-hidden ${className}`}>
      {!loaded && src && <div className="absolute inset-0 skeleton" />}
      {src && (
        // eslint-disable-next-line @next/next/no-img-element -- deliberate: this component is the app's poster primitive and is used at high density (Cinema Mode rows put dozens on screen). Routing every one through next/image made this server transcode hundreds of TMDB images on demand while scrolling, which was the phone's scroll lag. The URLs are already CDN images requested at the right width.
        <img
          src={src}
          alt={alt}
          {...({ fetchpriority: "high" } as Record<string, string>)}
          className={`h-full w-full object-cover object-top transition-opacity duration-700 ${loaded ? "opacity-100" : "opacity-0"}`}
          onLoad={() => setLoaded(true)}
          loading="eager"
        />
      )}
    </div>
  );
}
