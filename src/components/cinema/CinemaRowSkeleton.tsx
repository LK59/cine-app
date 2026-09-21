"use client";

/**
 * Des cartes vides à la place d'une rangée qui arrive — « Reprendre », « Ma liste ».
 *
 * Ces deux rangées sont personnelles et changent tout le temps : elles ne sont pas gardées sur
 * l'appareil (une rangée d'hier affichée un instant serait une information fausse), elles sont
 * demandées à chaque lancement. Jusqu'au 21/09/2026 elles n'existaient pas tant que la réponse
 * n'était pas là, puis apparaissaient d'un coup et poussaient tout l'écran vers le bas. La place
 * est maintenant tenue dès le premier affichage, et le reste de l'écran ne bouge plus.
 *
 * Seules les cartes sont partagées : chaque interface garde son propre en-tête de rangée, parce
 * que le bureau et le téléphone sont deux produits (voir CLAUDE.md), pas deux tailles d'écran.
 * Inertes pour le clavier comme pour le lecteur d'écran — elles ne sont pas encore quelque chose.
 */
export function CinemaSkeletonCards({
  cardClassName,
  shape,
  count = 6,
}: {
  cardClassName: string;
  shape: "poster" | "still";
  count?: number;
}) {
  return (
    <>
      {Array.from({ length: count }, (_, i) => (
        <div
          key={i}
          aria-hidden
          data-row-skeleton
          className={`${cardClassName} shrink-0 animate-pulse rounded-lg bg-white/[0.06] ${shape === "poster" ? "aspect-2/3" : "aspect-video"}`}
        />
      ))}
    </>
  );
}

/** « En train d'arriver » : ni donnée ni erreur. Une erreur vide la place au lieu de la tenir. */
export function isRowPending(data: unknown, error: unknown): boolean {
  return data === undefined && error === undefined;
}
