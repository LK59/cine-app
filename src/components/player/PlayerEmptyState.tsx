"use client";

/**
 * Un écran vide qui dit quoi faire.
 *
 * Une liste vide se présentait comme une phrase grise perdue en haut d'une page blanche, ce qui
 * ressemble davantage à un chargement raté qu'à « il n'y a rien ici ». Trois choses suffisent à
 * faire la différence : un signe qu'on est au bon endroit, une phrase qui dit pourquoi c'est vide,
 * et un chemin pour que ça ne le reste pas.
 *
 * L'action est facultative — certains vides sont une bonne nouvelle et n'ont rien à proposer.
 */
export function PlayerEmptyState({
  icon: Icon,
  message,
  action,
}: {
  icon: React.ElementType;
  message: string;
  action?: { label: string; onClick: () => void } | null;
}) {
  return (
    <div className="flex flex-col items-center gap-4 px-6 py-16 text-center">
      <span className="flex h-14 w-14 items-center justify-center rounded-full bg-white/5 text-slate-600 ring-1 ring-white/10">
        <Icon size={24} />
      </span>
      <p className="max-w-sm text-sm leading-6 text-slate-400">{message}</p>
      {action && (
        <button type="button" onClick={action.onClick} className="btn btn-ghost">
          {action.label}
        </button>
      )}
    </div>
  );
}
