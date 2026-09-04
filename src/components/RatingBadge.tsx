import { Star } from "lucide-react";

/**
 * La note TMDb posée sur une affiche.
 *
 * Dessinée à la main dans la fiche personne et dans ActorModal, avec deux tailles d'étoile et
 * deux fonds légèrement différents. `ImdbBadge` existe pour la note IMDb ; celle-ci est son
 * pendant pour la note TMDb, qui n'est pas la même donnée et ne se lit pas au même endroit.
 */
export function RatingBadge({ value, className = "" }: { value: number; className?: string }) {
  if (!value) return null;
  return (
    <span
      className={`inline-flex items-center gap-0.5 rounded-sm bg-black/75 px-1.5 py-0.5 text-[10px] font-semibold text-amber-400 ${className}`}
    >
      <Star size={8} className="fill-current" />
      {value.toFixed(1)}
    </span>
  );
}
