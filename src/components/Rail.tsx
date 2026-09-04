import type { CSSProperties, ReactNode } from "react";

/**
 * Une rangée qui défile horizontalement — la forme la plus répandue de l'app, et jusqu'ici la
 * moins tenue.
 *
 * Quinze appels, dix jeux de classes différents : `pb-2` ou `pb-3`, avec ou sans `snap`, avec ou
 * sans barre de défilement fine. La même bibliothèque n'avait donc pas tout à fait le même
 * comportement d'un écran à l'autre, sans que rien ne le justifie.
 *
 * Le retrait latéral n'est pas cosmétique. Un conteneur qui défile rogne à son bord, et l'anneau
 * de survol ou de focus d'une carte déborde du sien : sur la première carte d'une rangée, il
 * était coupé net à gauche. Six pixels de marge intérieure, annulés à l'extérieur par la marge
 * négative, lui laissent la place sans décaler la rangée.
 */
export function Rail({
  children,
  className = "",
  style,
}: {
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <div
      className={`scrollbar-thin -mx-1.5 flex snap-x snap-mandatory gap-3 overflow-x-auto px-1.5 pb-2 scroll-px-1.5 ${className}`}
      style={style}
    >
      {children}
    </div>
  );
}
