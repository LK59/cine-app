/**
 * Le remplissage d'une barre de progression — ce qu'on a déjà vu d'un film ou d'un épisode.
 *
 * Il apparaissait d'un coup. Il se remplit désormais depuis la gauche jusqu'à sa valeur quand la
 * rangée arrive — « tu en étais là » —, et glisse vers la nouvelle quand elle change après une
 * lecture, au lieu de sauter (23/09/2026). Trois endroits le dessinaient chacun à sa façon : la
 * rangée « Reprendre » du bureau, celle du téléphone et la progression des épisodes.
 *
 * L'arrivée anime une échelle et non la largeur (voir `progress-fill`, globals.css) : rien ne se
 * recalcule autour pendant qu'elle joue. « Réduire les animations » la ramène à rien.
 *
 * Sa couleur est le faisceau du logo (`bg-beam`, 23/10/2026) : la seule surface à le porter, la barre
 * d'une vignette (DECISIONS.md §83). L'échelle de l'arrivée l'emporte avec elle.
 */
export function ProgressFill({ percent }: { percent: number }) {
  return <div className="progress-fill h-full bg-beam" style={{ width: `${percent}%` }} />;
}
