"use client";

import type { ImgHTMLAttributes } from "react";
import { revealLoaded, showIfAlreadyLoaded } from "@/lib/imageReveal";

/**
 * Une image de fond qui arrive en fondu — et qui ne le rejoue pas quand elle est déjà là.
 *
 * Les visuels des fiches surgissaient d'un coup : sur téléphone la fiche montait avec une bannière
 * vide, puis l'image apparaissait sèchement, quand les affiches arrivent en fondu et les logos
 * aussi (relevé le 23/09/2026). Même mécanisme que `PosterImage`, même durée : l'apparition se
 * joue sur le nœud, pas dans un état React, et une image que le navigateur a déjà s'affiche
 * aussitôt.
 */
export function FadeInImg({ className = "", onLoad, alt = "", ...rest }: ImgHTMLAttributes<HTMLImageElement>) {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      {...rest}
      alt={alt}
      ref={showIfAlreadyLoaded}
      className={`${className} opacity-0 transition-opacity duration-500`}
      onLoad={(event) => {
        revealLoaded(event.currentTarget);
        onLoad?.(event);
      }}
    />
  );
}
