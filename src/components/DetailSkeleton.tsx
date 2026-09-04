/**
 * La forme d'une fiche pendant qu'elle se remplit.
 *
 * Les fiches film et série remplaçaient toute la page par un spinner : écran vide, puis tout
 * apparaît d'un coup et la mise en page saute. Les grandes grilles avaient déjà leur squelette,
 * qui garde la forme de la page — c'est ce qui fait qu'une app *paraît* rapide. Voici la même
 * chose pour une fiche : la bande, l'affiche, le titre, la rangée d'actions.
 */
export function DetailSkeleton() {
  return (
    <div className="relative -mx-4 -mt-4 animate-pulse sm:-mx-6 sm:-mt-6 md:-mx-8 md:-mt-6">
      <div className="h-[32vw] min-h-[180px] max-h-[380px] bg-slate-900 xl:max-h-[520px]" />
      <div className="relative -mt-16 px-4 pb-6 sm:-mt-20 sm:px-6 md:px-8">
        <div className="flex max-w-4xl items-end gap-4 sm:gap-6">
          <div className="hidden h-[132px] w-[88px] shrink-0 rounded-lg bg-slate-800 sm:block md:h-[168px] md:w-28" />
          <div className="flex-1 space-y-2 pb-1">
            <div className="h-7 w-2/3 rounded-md bg-slate-800" />
            <div className="flex gap-2">
              <div className="h-4 w-14 rounded-sm bg-slate-800" />
              <div className="h-4 w-20 rounded-sm bg-slate-800" />
              <div className="h-4 w-16 rounded-sm bg-slate-800" />
            </div>
          </div>
        </div>
      </div>
      <div className="px-4 sm:px-6 md:px-8">
        <div className="mb-4 flex flex-wrap gap-2">
          <div className="h-8 w-24 rounded-lg bg-slate-800" />
          <div className="h-8 w-28 rounded-lg bg-slate-800" />
          <div className="h-8 w-24 rounded-lg bg-slate-800" />
          <div className="h-8 w-9 rounded-lg bg-slate-800" />
        </div>
        <div className="space-y-2">
          <div className="h-3 w-full rounded-sm bg-slate-800" />
          <div className="h-3 w-11/12 rounded-sm bg-slate-800" />
          <div className="h-3 w-4/6 rounded-sm bg-slate-800" />
        </div>
      </div>
    </div>
  );
}
