"use client";

import Link from "next/link";
import { useState } from "react";
import { useRouter } from "next/navigation";
import useSWR from "swr";
import { fetcher } from "@/lib/swr";
import { PageHeader } from "@/components/PageHeader";
import { EmptyState } from "@/components/StateViews";
import { WatchlistButton } from "@/components/WatchlistButton";
import type { RecommendationGroup, RecommendedMovie } from "@/app/api/recommendations/route";
import { Star, CheckCircle, PlusCircle, ExternalLink } from "lucide-react";
import { HorizontalCarousel } from "@/components/HorizontalCarousel";
import { CarouselSkeleton } from "@/components/SkeletonCard";
import { ActionSheet } from "@/components/ActionSheet";
import { useLongPress } from "@/hooks/useLongPress";

function MovieCard({ m }: { m: RecommendedMovie }) {
  const router = useRouter();
  const [requesting, setRequesting] = useState(false);
  const [requested, setRequested] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  async function doRequest() {
    setRequesting(true);
    await fetch("/api/jellyseerr/requests", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mediaType: "movie", mediaId: m.tmdbId }),
    });
    setRequested(true);
    setRequesting(false);
  }

  const lp = useLongPress(() => setMenuOpen(true));

  const cardContent = (
    <div className="group relative flex-shrink-0 w-32 [touch-action:manipulation] select-none">
      <div className="relative overflow-hidden rounded-lg aspect-[2/3] bg-slate-800">
        {m.posterPath ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={m.posterPath} alt={m.title} className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-105" />
        ) : (
          <div className="flex h-full items-center justify-center text-slate-600 text-xs text-center p-2">{m.title}</div>
        )}

        {m.inLibrary && (
          <div className="absolute top-1.5 right-1.5 rounded-full bg-emerald-500/90 p-0.5">
            <CheckCircle size={10} className="text-white" />
          </div>
        )}

        {/* Hover overlay */}
        <div className="absolute inset-0 flex flex-col justify-end bg-gradient-to-t from-slate-900/95 via-slate-900/30 to-transparent opacity-0 group-hover:opacity-100 transition-opacity p-2 gap-1.5">
          <div className="flex items-center gap-1 text-[10px] text-amber-400">
            <Star size={9} fill="currentColor" />
            {m.voteAverage.toFixed(1)}
          </div>
          <WatchlistButton
            tmdbId={m.tmdbId}
            mediaType="movie"
            title={m.title}
            year={m.year ?? undefined}
            posterPath={m.posterPath}
            size="sm"
          />
          {!m.inLibrary && (
            <button
              onClick={(e) => { e.preventDefault(); e.stopPropagation(); doRequest(); }}
              disabled={requesting || requested}
              className={`flex w-full items-center justify-center gap-1 rounded px-1.5 py-1 text-[10px] font-medium transition-colors ${
                requested ? "bg-emerald-500/20 text-emerald-400" : "bg-sky-500/20 text-sky-300 hover:bg-sky-500/30"
              }`}
            >
              <PlusCircle size={9} />
              {requested ? "Demandé" : requesting ? "…" : "Demander"}
            </button>
          )}
        </div>
      </div>

      <p className="mt-1.5 truncate text-[11px] font-medium text-slate-400 group-hover:text-slate-200 transition-colors">
        {m.title}
      </p>
      {m.year && <p className="text-[10px] text-slate-600">{m.year}</p>}
    </div>
  );

  const card = m.radarrId
    ? <Link {...lp} href={`/radarr/${m.radarrId}`}>{cardContent}</Link>
    : <div {...lp}>{cardContent}</div>;

  return (
    <>
      {card}
      <ActionSheet
        open={menuOpen}
        onClose={() => setMenuOpen(false)}
        title={m.title}
        subtitle={m.year ? String(m.year) : undefined}
        poster={m.posterPath}
        actions={[
          ...(m.radarrId ? [{ label: "Voir la fiche", icon: <ExternalLink size={16} />, onClick: () => router.push(`/radarr/${m.radarrId}`) }] : []),
          ...(!m.inLibrary && !requested ? [{
            label: requesting ? "Envoi…" : "Demander",
            icon: <PlusCircle size={16} />,
            onClick: doRequest,
            disabled: requesting,
            variant: "accent" as const,
          }] : []),
          ...(requested || m.inLibrary ? [{
            label: m.inLibrary ? "Déjà dans la bibliothèque" : "Demande envoyée",
            icon: <CheckCircle size={16} />,
            onClick: () => {},
            disabled: true,
          }] : []),
        ]}
      />
    </>
  );
}

function RecommendationRow({ group }: { group: RecommendationGroup }) {
  return (
    <div>
      <div className="mb-3 flex items-center gap-2">
        <span className="text-xs text-slate-500">Parce que vous avez regardé</span>
        <span className="text-sm font-semibold text-white">{group.seedTitle}</span>
      </div>
      <HorizontalCarousel className="flex gap-3 overflow-x-auto pb-2 snap-x snap-mandatory" style={{ scrollbarWidth: "none" }}>
        {group.movies.map((m) => <MovieCard key={m.tmdbId} m={m} />)}
      </HorizontalCarousel>
    </div>
  );
}

export default function RecommendationsPage() {
  const { data, isLoading } = useSWR<{ groups: RecommendationGroup[] }>(
    "/api/recommendations",
    fetcher,
    { revalidateOnFocus: false }
  );

  const groups = data?.groups ?? [];

  return (
    <div>
      <PageHeader
        title="Recommandations"
        subtitle="Basées sur votre historique Jellyfin"
      />

      {isLoading && (
        <div className="space-y-8">
          {[0, 1, 2].map((i) => (
            <div key={i}>
              <div className="mb-3 flex items-center gap-2">
                <div className="h-3 w-32 rounded bg-slate-800 animate-pulse" />
                <div className="h-4 w-40 rounded bg-slate-700 animate-pulse" />
              </div>
              <HorizontalCarousel className="flex gap-3 overflow-x-auto pb-2" style={{ scrollbarWidth: "none" }}>
                <CarouselSkeleton count={5} width="w-32" />
              </HorizontalCarousel>
            </div>
          ))}
        </div>
      )}

      {!isLoading && groups.length === 0 && (
        <EmptyState label="Aucune recommandation — regardez quelques films sur Jellyfin pour en générer." />
      )}

      {groups.length > 0 && (
        <div className="space-y-8">
          {groups.map((g) => <RecommendationRow key={g.seedTmdbId} group={g} />)}
        </div>
      )}
    </div>
  );
}
