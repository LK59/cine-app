"use client";

// Single source of truth for the small amber IMDb rating pill — was previously duplicated
// ad-hoc (fiche pages, watchlist) with slightly different sizes; now shared everywhere a
// poster or a sheet header shows a rating, including the poster-grid overlay use below.
//
// Le mini logo IMDb à la place de l'étoile (10/10/2026) : une étoile dit « note », le logo dit
// d'où elle vient — une note IMDb n'est pas celle de TMDB ni des critiques. Dessiné ici, en SVG, et
// non chargé : il est à la taille du texte, partout où le badge apparaît, sans requête de plus.
function ImdbMark({ height }: { height: number }) {
  return (
    <svg viewBox="0 0 64 32" height={height} width={height * 2} role="img" aria-label="IMDb" className="block shrink-0">
      <rect width="64" height="32" rx="5" fill="#F5C518" />
      <text
        x="32"
        y="23"
        textAnchor="middle"
        fontFamily="Arial, Helvetica, sans-serif"
        fontWeight="900"
        fontSize="20"
        letterSpacing="-0.5"
        fill="#000"
      >
        IMDb
      </text>
    </svg>
  );
}

export function ImdbBadge({
  rating,
  size = "xs",
  className,
}: {
  rating: string | number | null | undefined;
  size?: "xs" | "sm";
  className?: string;
}) {
  if (rating === null || rating === undefined || rating === "") return null;
  const value = typeof rating === "number" ? rating.toFixed(1) : rating;
  return (
    <span
      // `leading-none` : la hauteur de ligne du texte dépassait celle du logo, et le chiffre, calé sur
      // sa propre ligne, paraissait trop haut à côté de lui (10/10/2026). Au plus juste, les deux
      // boîtes ont la même hauteur et `items-center` les centre vraiment.
      className={`inline-flex items-center gap-1 rounded-sm bg-amber-500/20 font-semibold leading-none text-amber-400 ${
        size === "xs" ? "px-1 py-0.5 text-[10px]" : "px-2 py-0.5 text-xs"
      } ${className ?? ""}`}
    >
      <ImdbMark height={size === "xs" ? 9 : 12} />
      {/* Descendu d'un rien : les chiffres n'ont pas de jambage, ils occupent le haut de leur ligne
          et paraissaient plus hauts que le logo, même lignes centrées au centième de pixel. */}
      <span className="relative top-[0.08em] tabular-nums">{value}</span>
    </span>
  );
}
