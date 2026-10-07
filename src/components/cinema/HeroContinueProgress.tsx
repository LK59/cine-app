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
  /** Centré sous un logo centré (téléphone) ; aligné à gauche sinon (bureau). */
  centered?: boolean;
}) {
  if (!caption && progress === null) return null;
  return (
    <div className={`flex items-center gap-2.5 ${centered ? "justify-center" : ""}`}>
      {progress !== null && (
        <div className="h-1 w-16 shrink-0 overflow-hidden rounded-full bg-white/25" aria-hidden>
          <ProgressFill percent={Math.round(progress * 100)} />
        </div>
      )}
      {caption && <span className="truncate text-xs font-medium tabular-nums text-muted">{caption}</span>}
    </div>
  );
}
