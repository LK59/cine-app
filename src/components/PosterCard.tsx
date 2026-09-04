"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Star, BookCheck, CirclePlus, ExternalLink, Loader2, Clock,
  Eye, Heart, X, CircleCheck, Telescope, Film, Tv, Plus, EllipsisVertical,
} from "lucide-react";
import { ActionSheet, type SheetAction } from "@/components/ActionSheet";
import { ReleaseSearchModal } from "@/components/ReleaseSearchModal";
import { RequestFlowModal } from "@/components/RequestFlowModal";
import { useAddToWatchlist } from "@/lib/useAddToWatchlist";
import { useRole } from "@/lib/useRole";
import { useToast } from "@/components/Toast";
import { apiAction } from "@/lib/apiAction";
import { useT } from "@/components/TranslationProvider";
import type { WatchlistStatus } from "@/lib/db";

export interface PosterCardItem {
  tmdbId: number;
  title: string;
  year: number | null;
  posterUrl: string | null;
  rating: number;
  inLibrary: boolean;
  libraryHref: string | null;
  /** Already requested/added but not yet available in the library. */
  pending?: boolean;
  /** Current watchlist status, if already on the list — from a bulk-status lookup. */
  watchlistStatus?: WatchlistStatus | null;
}

const ALL_STATUSES: WatchlistStatus[] = ["to_watch", "favorite", "watched", "to_request", "abandoned"];

interface Props {
  item: PosterCardItem;
  mediaType: "movie" | "series";
  size?: "grid" | "carousel";
  /** Called after a successful admin interactive-search add (item just entered the library pipeline). */
  onAdded?: (tmdbId: number) => void;
}

export function PosterCard({ item, mediaType, size = "grid", onAdded }: Props) {
  const router = useRouter();
  const { role } = useRole();
  const isAdmin = role === "admin";
  const toast = useToast();
  const t = useT();

  const [sheetOpen, setSheetOpen] = useState(false);
  const [requestModalOpen, setRequestModalOpen] = useState(false);
  const [requested, setRequested] = useState(false);
  const { addedStatus, addToWatchlist: addToWatchlistBase } = useAddToWatchlist(item.watchlistStatus ?? null);
  const [addingSearch, setAddingSearch] = useState(false);
  const [releaseModal, setReleaseModal] = useState<{ searchEndpoint: string; grabEndpoint: string; mediaId?: number } | null>(null);

  const STATUS_META: Record<WatchlistStatus, { label: string; icon: React.ElementType; textColor: string; bgSolid: string }> = {
    to_watch:   { label: t("watchlist.statuses.toWatch"),   icon: Eye,          textColor: "text-sky-400",     bgSolid: "bg-sky-500" },
    to_request: { label: t("watchlist.statuses.toRequest"), icon: Clock,        textColor: "text-amber-400",   bgSolid: "bg-amber-500" },
    favorite:   { label: t("watchlist.statuses.favorites"), icon: Heart,        textColor: "text-rose-400",    bgSolid: "bg-rose-500" },
    watched:    { label: t("watchlist.statuses.watched"),   icon: CircleCheck, textColor: "text-emerald-400", bgSolid: "bg-emerald-500" },
    abandoned:  { label: t("watchlist.statuses.abandoned"), icon: X,            textColor: "text-slate-400",   bgSolid: "bg-slate-500" },
  };

  function addToWatchlist(status: WatchlistStatus) {
    addToWatchlistBase(
      {
        tmdbId: item.tmdbId,
        mediaType,
        title: item.title,
        year: item.year,
        posterPath: item.posterUrl,
        voteAverage: item.rating,
      },
      status
    );
  }

  // Movies only — series no longer pair an add with an immediate interactive search a user can
  // abandon without picking anything (reported live as leaving a monitored, endlessly-re-searched
  // empty entry). discover/add now adds a movie unmonitored; grabbing a release flips it back.
  //
  // `onAdded` n'est volontairement pas prévenu ici, mais à la fermeture de la fenêtre de
  // recherche. Le parent s'en sert pour reclasser la carte parmi les titres déjà présents,
  // c'est-à-dire pour la déplacer dans une *autre* grille : React démonte alors cette carte
  // et en remonte une neuve ailleurs, ce qui emporte son état — dont la fenêtre qu'on vient
  // d'ouvrir. Depuis la fiche d'un film, « Saga » puis « recherche interactive » ajoutait donc
  // bien le film à Radarr, mais la fenêtre de recherche disparaissait avant d'être peinte.
  async function doInteractiveSearch(e?: React.MouseEvent) {
    e?.preventDefault(); e?.stopPropagation();
    setAddingSearch(true);
    try {
      const data = (await apiAction("/api/discover/add", {
        method: "POST",
        body: JSON.stringify({ type: "movie", tmdbId: item.tmdbId }),
      })) as { radarrId?: number } | null;
      if (data?.radarrId) {
        setReleaseModal({ searchEndpoint: `/api/radarr/movies/${data.radarrId}/releases`, grabEndpoint: `/api/radarr/releases`, mediaId: data.radarrId });
      } else {
        // Ajouté sans identifiant exploitable : rien à chercher, mais le parent doit le savoir.
        onAdded?.(item.tmdbId);
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("common.unknown"));
    } finally {
      setAddingSearch(false);
    }
  }

  // Series: a deliberate, explicit "add to my library" action — no interactive search follows,
  // so no orphan-on-abandon risk; added normally monitored. Per-season interactive AND automatic
  // search live on the series' own sheet once it's in the library.
  async function addSeriesToLibrary(e?: React.MouseEvent) {
    e?.preventDefault(); e?.stopPropagation();
    setAddingSearch(true);
    try {
      const data = (await apiAction("/api/discover/add", {
        method: "POST",
        body: JSON.stringify({ type: "series", tmdbId: item.tmdbId }),
      })) as { sonarrId?: number } | null;
      if (data?.sonarrId) {
        toast.success(t("watchlist.addedToLibrary"));
        onAdded?.(item.tmdbId);
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("common.unknown"));
    } finally {
      setAddingSearch(false);
    }
  }

  function handlePosterClick() {
    if (window.matchMedia("(pointer: coarse)").matches) {
      setSheetOpen(true);
    } else if (item.libraryHref) {
      router.push(item.libraryHref);
    }
  }

  /**
   * Les actions d'abord, les statuts de liste ensuite — et rien qui n'ait de sens ici.
   *
   * La feuille s'ouvrait sur les cinq statuts, ce qui reléguait « voir la fiche » en sixième
   * position alors que c'est ce que l'on vient chercher neuf fois sur dix. Et elle proposait
   * « Demander » à tout coup, y compris pour un titre déjà présent dans la bibliothèque : au
   * survol, la même carte propose l'un *ou* l'autre depuis toujours, jamais les deux.
   */
  const sheetActions: SheetAction[] = [
    ...(item.libraryHref
      ? [{ label: t("recommendations.viewSheet"), icon: <ExternalLink size={16} />, onClick: () => router.push(item.libraryHref!) }]
      : []
    ),
    ...(!item.inLibrary
      ? [{
          label: requested || item.pending ? t("recommendations.requestSent") : t("recommendations.request"),
          icon: <CirclePlus size={16} />,
          onClick: () => setRequestModalOpen(true),
          disabled: requested || item.pending === true,
          variant: (requested || item.pending ? "accent" : "default") as "accent" | "default",
        }]
      : []),
    ...(isAdmin && mediaType === "movie" && !item.inLibrary ? [{
      label: t("recommendations.interactiveSearch"),
      icon: <Telescope size={16} />,
      onClick: () => doInteractiveSearch(),
      disabled: addingSearch,
    }] : []),
    ...(isAdmin && mediaType === "series" && !item.inLibrary ? [{
      label: t("watchlist.addToLibrary"),
      icon: <Plus size={16} />,
      onClick: () => addSeriesToLibrary(),
      disabled: addingSearch,
    }] : []),
    ...ALL_STATUSES.map((s) => {
      const meta = STATUS_META[s];
      const Icon = meta.icon;
      return {
        label: meta.label,
        icon: <Icon size={16} />,
        onClick: () => addToWatchlist(s),
        variant: (addedStatus === s ? "accent" : "default") as "accent" | "default",
        disabled: addedStatus === s,
        section: t("watchlist.pageTitle"),
      };
    }),
  ];

  const AddedIcon = addedStatus ? STATUS_META[addedStatus].icon : null;
  const carousel = size === "carousel";
  const btnSize = carousel ? 20 : 22;
  const iconSize = carousel ? 8 : 9;

  return (
    <>
      <div className={`group relative flex flex-col select-none touch-manipulation ${carousel ? "w-24 shrink-0" : ""}`}>
        <div
          className={`relative aspect-2/3 overflow-hidden bg-slate-800 cursor-pointer ${carousel ? "rounded-lg" : "rounded-xl"}`}
          onClick={handlePosterClick}
        >
          {item.posterUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={item.posterUrl}
              alt={item.title}
              className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.04]"
              loading="lazy"
            />
          ) : (
            <div className="flex h-full items-center justify-center text-slate-600">
              {mediaType === "movie" ? <Film size={carousel ? 28 : 40} /> : <Tv size={carousel ? 28 : 40} />}
            </div>
          )}

          {item.inLibrary && (
            <div className="pointer-events-none absolute right-1.5 top-1.5 flex items-center gap-0.5 rounded-full bg-emerald-500/90 px-1.5 py-0.5 text-[9px] font-bold text-white">
              <BookCheck size={8} /> {t("recommendations.available")}
            </div>
          )}
          {!item.inLibrary && item.pending && (
            <div className="pointer-events-none absolute right-1.5 top-1.5 flex items-center gap-0.5 rounded-full bg-amber-500/90 px-1.5 py-0.5 text-[9px] font-bold text-white">
              <Clock size={8} /> {t("discover.pending")}
            </div>
          )}

          {/* La note reste visible en permanence : elle l'est partout ailleurs dans l'app, et une
              information qui n'apparaît qu'au survol n'existe pas sur un écran tactile. Ce qui a
              disparu, c'est son flou d'arrière-plan — recalculé par carte et par image pendant le
              défilement, pour un fond déjà opaque aux trois quarts. */}
          {item.rating > 0 && (
            <div className="pointer-events-none absolute bottom-1.5 left-1.5 flex items-center gap-0.5 rounded-full bg-black/75 px-1.5 py-0.5 text-[9px] font-bold text-amber-400">
              <Star size={7} className="fill-current" /> {item.rating.toFixed(1)}
            </div>
          )}

          {AddedIcon && (
            <div className={`pointer-events-none absolute bottom-1.5 right-1.5 rounded-full bg-black/70 p-1 ${STATUS_META[addedStatus!].textColor}`}>
              <AddedIcon size={8} />
            </div>
          )}

          {/* Desktop hover overlay */}
          <div className="absolute inset-0 hidden md:flex flex-col items-center justify-center gap-1.5 bg-black/80 opacity-0 transition-opacity duration-200 group-hover:opacity-100">
            {/* Une seule action de plus, au lieu des cinq états côte à côte. Sept contrôles
                apparaissant sur une affiche au survol, c'est un menu déguisé en rangée — et la
                liste complète existe déjà, c'est celle que le tactile ouvre depuis toujours.
                Un seul bouton la donne aux deux. */}
            <button
              onClick={(e) => {
                e.stopPropagation();
                setSheetOpen(true);
              }}
              title={t("common.moreOptions")}
              style={{ height: btnSize, width: btnSize }}
              className={`btn btn-icon p-0 ${
                addedStatus ? `${STATUS_META[addedStatus].bgSolid} text-white` : "bg-white/15 text-white/80 hover:bg-white/25"
              }`}
            >
              {addedStatus ? (
                (() => {
                  const Icon = STATUS_META[addedStatus].icon;
                  return <Icon size={iconSize} />;
                })()
              ) : (
                <EllipsisVertical size={iconSize} />
              )}
            </button>

            <div className="flex items-center gap-1">
              {item.libraryHref ? (
                <Link
                  href={item.libraryHref}
                  onClick={(e) => e.stopPropagation()}
                  className="flex items-center gap-1 rounded-lg bg-white/15 px-2 py-1 text-[10px] font-medium text-white hover:bg-white/25 transition-colors"
                >
                  <ExternalLink size={9} /> {t("recommendations.viewSheet")}
                </Link>
              ) : item.inLibrary ? null : (
                <button
                  onClick={(e) => { e.stopPropagation(); setRequestModalOpen(true); }}
                  disabled={requested || item.pending}
                  className={`btn btn-ghost btn-sm px-2 py-1 text-[10px] ${requested || item.pending ? "btn-on" : ""}`}
                >
                  <CirclePlus size={9} />
                  {requested || item.pending ? t("recommendations.requested") : t("recommendations.request")}
                </button>
              )}
              {isAdmin && mediaType === "movie" && !item.inLibrary && (
                <button
                  onClick={(e) => doInteractiveSearch(e)}
                  disabled={addingSearch}
                  title={t("recommendations.interactiveSearch")}
                  style={{ height: btnSize, width: btnSize }}
                  className="btn btn-ghost btn-icon rounded-lg p-0"
                >
                  {addingSearch ? <Loader2 size={iconSize} className="animate-spin" /> : <Telescope size={iconSize} />}
                </button>
              )}
              {isAdmin && mediaType === "series" && !item.inLibrary && (
                <button
                  onClick={(e) => addSeriesToLibrary(e)}
                  disabled={addingSearch}
                  title={t("watchlist.addToLibrary")}
                  style={{ height: btnSize, width: btnSize }}
                  className="btn btn-ghost btn-icon rounded-lg p-0"
                >
                  {addingSearch ? <Loader2 size={iconSize} className="animate-spin" /> : <Plus size={iconSize} />}
                </button>
              )}
            </div>
          </div>
        </div>

        <div className={carousel ? "mt-1" : "mt-1.5 px-0.5"}>
          <p className="truncate text-[11px] font-medium text-slate-400 group-hover:text-slate-200 transition-colors">{item.title}</p>
          {item.year && <p className="text-[10px] text-slate-600">{item.year}</p>}
        </div>
      </div>

      <ActionSheet
        open={sheetOpen}
        onClose={() => setSheetOpen(false)}
        title={item.title}
        subtitle={[item.year, mediaType === "movie" ? t("common.film") : t("common.series"), item.rating > 0 ? `★ ${item.rating.toFixed(1)}` : null].filter(Boolean).join(" · ")}
        poster={item.posterUrl}
        actions={sheetActions}
      />

      {releaseModal && (
        <ReleaseSearchModal
          title={item.title}
          searchEndpoint={releaseModal.searchEndpoint}
          grabEndpoint={releaseModal.grabEndpoint}
          mediaId={releaseModal.mediaId}
          onClose={() => {
            setReleaseModal(null);
            onAdded?.(item.tmdbId);
          }}
        />
      )}

      {requestModalOpen && (
        <RequestFlowModal
          mediaType={mediaType}
          tmdbId={item.tmdbId}
          title={item.title}
          onClose={() => setRequestModalOpen(false)}
          onSuccess={() => setRequested(true)}
        />
      )}
    </>
  );
}
