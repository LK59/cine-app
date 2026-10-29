"use client";

import { useEffect, useState } from "react";

/**
 * La couverture floue derrière l'en-tête d'une fiche de livre, faite une fois en une toute petite image.
 *
 * Elle était un `<img>` en taille réelle sous `filter: blur(64px)` (`blur-3xl`) : mesuré le 28/10/2026, le
 * navigateur repeignait ce flou à chaque ouverture et à chaque fermeture de fiche — 250 à 400 ms de fil
 * principal bloqué dans Chromium, pendant l'animation même (les « mini blocages » remarqués sur iPhone), et
 * la trajectoire de la fiche (`useSheetMorph`) en recopie le voile, donc le flou, dans son calque.
 *
 * Ici : l'image réduite à 16 × 24 points dans un canevas (avec un léger flou là où le canevas le sait),
 * rendue en `blob:` — étirée par le navigateur, elle donne le même lavis de couleur pour un coût nul, et une
 * copie du nœud (le calque du trajet) la garde, ce qu'un canevas recopié ne ferait pas (il serait vide).
 * Gardée par adresse : rouvrir la fiche ne refait rien. `blob:` et non `data:` (29/10/2026) : la politique
 * d'images du cinéma refuse `data:` exprès, et le lavis n'apparaissait nulle part, une violation en console
 * à chaque fiche ouverte.
 */
const W = 16;
const H = 24;
const made = new Map<string, string>();
const MAX_KEPT = 64;

function wash(url: string): Promise<string | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.decoding = "async";
    img.onload = () => {
      try {
        const canvas = document.createElement("canvas");
        canvas.width = W;
        canvas.height = H;
        const ctx = canvas.getContext("2d");
        if (!ctx) return resolve(null);
        // Le léger flou adoucit la grille que l'agrandissement laisserait voir ; sans lui (anciens Safari),
        // l'interpolation suffit sous le voile dégradé.
        if ("filter" in ctx) ctx.filter = "blur(1.2px)";
        // Recadrée comme `object-cover` : le centre de l'image, aux proportions du canevas.
        const ratio = W / H;
        const sw = Math.min(img.naturalWidth, img.naturalHeight * ratio);
        const sh = sw / ratio;
        ctx.drawImage(img, (img.naturalWidth - sw) / 2, (img.naturalHeight - sh) / 2, sw, sh, 0, 0, W, H);
        canvas.toBlob((blob) => resolve(blob ? URL.createObjectURL(blob) : null), "image/png");
      } catch {
        resolve(null);
      }
    };
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

/** Le lavis d'une couverture, `null` tant qu'il n'est pas fait (ou si l'image manque). */
export function useCoverWash(url: string | null): string | null {
  const [state, setState] = useState<{ url: string; wash: string | null } | null>(null);
  useEffect(() => {
    if (!url || made.has(url)) return;
    let live = true;
    void wash(url).then((w) => {
      if (w) {
        if (made.size >= MAX_KEPT) {
          const oldest = made.keys().next().value as string;
          URL.revokeObjectURL(made.get(oldest) as string);
          made.delete(oldest);
        }
        made.set(url, w);
      }
      if (live) setState({ url, wash: w });
    });
    return () => {
      live = false;
    };
  }, [url]);
  if (!url) return null;
  return made.get(url) ?? (state?.url === url ? state.wash : null);
}
