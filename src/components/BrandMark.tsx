import { useId } from "react";

/**
 * Le logo de Laterna sans son carré de fond — le faisceau et la barre du « L » — pour les endroits
 * où il se pose directement sur l'interface : le rail du cinéma, la barre du téléphone, la barre
 * latérale de la gestion, l'en-tête de l'état des services et de l'assistant.
 *
 * Le même dessin que `tools/brand/icon.svg` (sans le triangle, trop fin à ces tailles), cadré sur
 * le glyphe pour qu'une `size` donnée soit la taille visible, comme celle d'une icône lucide. Les
 * couleurs sont celles du logo, écrites ici et non prises aux jetons : c'est une image, pas un état.
 *
 * Les identifiants des dégradés passent par `useId` : deux logos dans la même page (le rail et la
 * barre du téléphone se croisent en paysage) se seraient sinon partagé le premier `id` rencontré,
 * et un `display: none` sur celui-là effaçait les couleurs de l'autre.
 */
export function BrandMark({
  size = 20,
  className = "",
  title,
}: {
  size?: number;
  className?: string;
  /** Un nom accessible ; sans lui, le logo est décoratif (`aria-hidden`). */
  title?: string;
}) {
  const id = useId().replace(/:/g, "");
  const bar = `brand-bar-${id}`;
  const beam = `brand-beam-${id}`;
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="117 98 310 310"
      width={size}
      height={size}
      className={`shrink-0 ${className}`}
      data-brand-mark=""
      {...(title ? { role: "img", "aria-label": title } : { "aria-hidden": true, focusable: false })}
    >
      <defs>
        <linearGradient id={bar} x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#7c5cff" />
          <stop offset="100%" stopColor="#38bdf8" />
        </linearGradient>
        <linearGradient id={beam} x1="0%" y1="0%" x2="100%" y2="0%">
          <stop offset="0%" stopColor="#7c5cff" stopOpacity="0.95" />
          <stop offset="100%" stopColor="#38bdf8" stopOpacity="0.25" />
        </linearGradient>
      </defs>
      <polygon points="168,290 408,222 408,402 168,346" fill={`url(#${beam})`} />
      <rect x="136" y="104" width="60" height="242" rx="18" fill={`url(#${bar})`} />
    </svg>
  );
}
