"use client";

import { Clock, CalendarClock, CircleCheck, CircleAlert, X } from "lucide-react";
import { PosterImage } from "@/components/PosterImage";
import { useT } from "@/components/TranslationProvider";
import type { PlayerRequest } from "@/lib/playerRequests";
import type { PlayerRequestState } from "@/lib/playerRequestState";

const STATE_ICON: Record<PlayerRequestState, React.ElementType> = {
  unreleased: CalendarClock,
  processing: Clock,
  available: CircleCheck,
  failed: CircleAlert,
};

const STATE_TONE: Record<PlayerRequestState, string> = {
  unreleased: "bg-white/10 text-slate-300",
  processing: "bg-accent-500/20 text-accent-300",
  available: "bg-emerald-500/15 text-emerald-300",
  failed: "bg-red-500/15 text-red-300",
};

/**
 * Une demande, avec son état écrit en toutes lettres.
 *
 * Trois états et rien de plus, parce que la validation est automatique : « pas encore sorti »,
 * « en cours », « disponible » — plus le cas où ça n'a pas abouti, qu'on préfère dire plutôt que
 * de laisser tourner un chargement éternel. Aucune mention de Jellyseerr, de Radarr, de qualité
 * ou d'approbation : ce sont des mots d'administration, et personne ici n'administre.
 *
 * Une demande disponible devient cliquable et mène à la fiche : c'est la récompense, et c'est
 * aussi pourquoi elle reste dans la liste au lieu d'en disparaître le jour où elle aboutit.
 */
export function PlayerRequestCard({
  request,
  onOpen,
  onCancel,
  busy,
}: {
  request: PlayerRequest;
  onOpen: () => void;
  onCancel: () => void;
  busy: boolean;
}) {
  const t = useT();
  const Icon = STATE_ICON[request.state];
  // Ouvrable dès que le titre est arrivé — vers sa fiche de bibliothèque, ou à défaut vers sa
  // fiche TMDB (voir `openRequest`). Une carte qui annonce « disponible » et ne réagit pas au
  // clic est le pire des deux mondes.
  const openable = request.state === "available" && (request.libraryId !== null || request.tmdbId !== null);

  return (
    <div className="group relative flex flex-col">
      <button
        type="button"
        onClick={openable ? onOpen : undefined}
        aria-disabled={!openable}
        className={`relative overflow-hidden rounded-xl bg-white/5 ring-1 ring-white/10 transition duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 ${
          openable ? "cursor-pointer group-hover:ring-white/30" : "cursor-default"
        }`}
      >
        <div className="aspect-[2/3]">
          {request.poster ? (
            <PosterImage src={request.poster} alt={request.title} />
          ) : (
            <div className="flex h-full w-full items-center justify-center text-slate-600">
              <Icon size={26} />
            </div>
          )}
        </div>
        {/* Un titre en attente n'est pas encore un titre qu'on regarde : l'affiche est voilée
            tant qu'il n'est pas là, et redevient nette le jour où il arrive. */}
        {!openable && <div className="absolute inset-0 bg-ink/55" />}
        <span
          className={`absolute bottom-1.5 left-1.5 right-1.5 flex items-center justify-center gap-1 truncate rounded-md px-1.5 py-1 text-[10px] font-medium ${STATE_TONE[request.state]}`}
        >
          <Icon size={11} className="shrink-0" />
          {t(`player.requests.state.${request.state}`)}
        </span>
      </button>

      {request.canCancel && request.state !== "available" && (
        <button
          type="button"
          onClick={onCancel}
          disabled={busy}
          aria-label={t("player.requests.cancel", { title: request.title })}
          title={t("player.requests.cancelHint")}
          // Visible en permanence, pas seulement au survol : sur un téléphone il n'y a pas de
          // survol, et un bouton qui n'apparaît jamais n'existe pas. Discret au repos, franc dès
          // qu'on s'en approche.
          className="absolute right-1.5 top-1.5 flex h-7 w-7 items-center justify-center rounded-full bg-black/70 text-slate-400 opacity-70 transition hover:text-white hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 group-hover:opacity-100 disabled:opacity-30"
        >
          <X size={14} />
        </button>
      )}

      <p className="mt-2 line-clamp-2 text-[13px] font-medium leading-snug text-slate-100">{request.title}</p>
      {request.year && <p className="mt-0.5 text-[11px] text-slate-500">{request.year}</p>}
    </div>
  );
}
