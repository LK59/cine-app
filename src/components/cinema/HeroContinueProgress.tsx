import { ProgressFill } from "@/components/cinema/ProgressFill";

/**
 * Où l'on en est, au-dessus du bouton de la bannière Reprendre / À suivre (DECISIONS.md §52) : la
 * barre des cartes de la rangée — même couleur, même remplissage — et ce qu'il reste à voir,
 * « S1 · É3 · 20 min restantes ». Rien quand il n'y a rien à dire : un complément « À la une »
 * n'a ni barre ni légende, et c'est ce qui le distingue d'une reprise.
 */
export function HeroContinueProgress({
  caption,
  progress,
  centered = false,
}: {
  caption: string | null;
  progress: number | null;
  /**
   * Centré sous un logo centré (téléphone) : la légende au-dessus de la barre, pour qu'une carte
   * étroite ne la coupe pas. Aligné à gauche sinon (bureau), barre et légende sur une ligne.
   */
  centered?: boolean;
}) {
  if (!caption && progress === null) return null;
  return (
    <div className={centered ? "flex flex-col items-center gap-1.5" : "flex items-center gap-2.5"}>
      {centered && caption && <span className="max-w-full truncate text-xs font-medium tabular-nums text-muted">{caption}</span>}
      {progress !== null && (
        <div className={`h-1 shrink-0 overflow-hidden rounded-full bg-white/25 ${centered ? "w-24" : "w-16"}`} aria-hidden>
          <ProgressFill percent={Math.round(progress * 100)} />
        </div>
      )}
      {!centered && caption && <span className="truncate text-xs font-medium tabular-nums text-muted">{caption}</span>}
    </div>
  );
}
