"use client";

import Link from "next/link";
import { useRouter, useParams } from "next/navigation";
import useSWR from "swr";
import { fetcher } from "@/lib/swr";
import { ErrorState } from "@/components/StateViews";
import { WatchlistButton } from "@/components/WatchlistButton";
import { RequestFlowModal } from "@/components/RequestFlowModal";
import { TMDB_IMAGE_BASE } from "@/lib/tmdbImageBase";
import {
  ArrowLeft, Star, Film, Tv, BookCheck, User, Calendar, MapPin, Briefcase,
  X, ChevronLeft, ChevronRight, Globe, CirclePlus,
} from "lucide-react";
import { useState } from "react";
import { createPortal } from "react-dom";
import type { EnrichedPersonData } from "@/app/api/tmdb/person/[id]/enriched/route";
import { selectBio } from "@/lib/format";
import { InstagramIcon } from "@/components/BrandIcons";
import { MediaCard } from "@/components/MediaCard";
import { DetailSkeleton } from "@/components/DetailSkeleton";
import { RatingBadge } from "@/components/RatingBadge";
import { apiAction } from "@/lib/apiAction";
import { useT, useLocale } from "@/components/TranslationProvider";
import { getDateLocale } from "@/lib/i18n";
import { useToast } from "@/components/Toast";

// ─── Shared types ─────────────────────────────────────────────────────────────

interface PersonCredit {
  tmdbId: number;
  title: string;
  year: number | null;
  posterPath: string | null;
  mediaType: "movie" | "tv";
  character: string;
  voteAverage: number;
  inLibrary: boolean;
  libraryHref: string | null;
}

interface PersonData {
  name: string | null;
  profilePath: string | null;
  biography: string | null;
  birthday: string | null;
  deathday: string | null;
  placeOfBirth: string | null;
  knownFor: string | null;
  credits: PersonCredit[];
}

// ─── Generic credit card ──────────────────────────────────────────────────────

function CreditCard({ c }: { c: PersonCredit }) {
  const t = useT();
  const toast = useToast();
  const [requesting, setRequesting] = useState(false);
  const [requested, setRequested] = useState(false);
  const poster = c.posterPath ? `${TMDB_IMAGE_BASE}/w342${c.posterPath}` : null;

  // Même règle que partout : c'est la réponse du serveur qui fait passer le bouton en « demandé ».
  // Une série demande ses saisons : la route refuse une demande sans elles (« Sélectionne au moins
  // une saison »), et le bouton échouait à chaque fois (08/10/2026). Le même choix de saisons que
  // partout ailleurs (`RequestFlowModal`).
  const [pickSeasons, setPickSeasons] = useState(false);
  async function doRequest(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (c.mediaType === "tv") {
      setPickSeasons(true);
      return;
    }
    setRequesting(true);
    try {
      await apiAction("/api/jellyseerr/requests", {
        method: "POST",
        body: JSON.stringify({ mediaType: "movie", mediaId: c.tmdbId }),
      });
      setRequested(true);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('common.error'));
    } finally {
      setRequesting(false);
    }
  }

  const content = (
    <MediaCard
      posterUrl={poster}
      alt={c.title}
      className="group"
      overlay={
        <>
        {c.inLibrary && (
          <div className="absolute right-1.5 top-1.5 rounded-sm bg-emerald-600/90 p-1">
            <BookCheck size={9} className="text-white" />
          </div>
        )}
        <RatingBadge value={c.voteAverage} className="absolute bottom-1.5 left-1.5" />
        {!c.inLibrary && (
          <div className="absolute inset-0 flex flex-col justify-end bg-linear-to-t from-slate-900/95 via-transparent to-transparent opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 pointer-coarse:opacity-100 transition-opacity p-2 gap-1.5">
            <WatchlistButton
              mediaType={c.mediaType === "movie" ? "movie" : "series"}
              tmdbId={c.tmdbId}
              title={c.title}
              year={c.year}
              posterPath={c.posterPath}
              size="sm"
              className="w-full justify-center"
            />
            <button
              onClick={doRequest}
              disabled={requesting || requested}
              className={`btn btn-ghost btn-sm w-full ${requested ? "btn-on" : ""}`}
            >
              <CirclePlus size={11} />
              {requested ? t('common.requested') : requesting ? t('common.requesting') : t('common.request')}
            </button>
          </div>
        )}
        </>
      }
    >
      <div className="flex flex-1 flex-col gap-1 p-2">
        <p className="line-clamp-2 text-xs font-medium leading-snug text-white">{c.title}</p>
        {c.character && <p className="line-clamp-1 text-[11px] text-slate-500 italic">{c.character}</p>}
        {c.year && <p className="text-[11px] text-slate-600">{c.year}</p>}
      </div>
    </MediaCard>
  );

  if (c.libraryHref) return <Link href={c.libraryHref}>{content}</Link>;
  return (
    <>
      {content}
      {pickSeasons && (
        <RequestFlowModal
          mediaType="series"
          tmdbId={c.tmdbId}
          title={c.title}
          onClose={() => setPickSeasons(false)}
          onSuccess={() => setRequested(true)}
        />
      )}
    </>
  );
}

function ExpandableBio({ text, source }: { text: string; source: "wikipedia" | "tmdb" }) {
  const t = useT();
  const [expanded, setExpanded] = useState(false);
  const limit = 500;
  const truncated = text.length > limit && !expanded;
  return (
    <div>
      <p className="text-sm leading-relaxed text-slate-300">
        {truncated ? text.slice(0, limit).trimEnd() + "…" : text}
      </p>
      <div className="mt-1.5 flex items-center gap-3">
        {text.length > limit && (
          <button onClick={() => setExpanded((v) => !v)} className="btn btn-ghost btn-sm mt-1 text-accent-300">
            {expanded ? t("person.collapse") : t("person.readMore")}
          </button>
        )}
        <span className="text-[10px] text-slate-600">{source === "wikipedia" ? t("person.sourceWikipedia") : t("person.sourceTmdb")}</span>
      </div>
    </div>
  );
}

function GenericPersonPage({ id, data }: { id: string; data: PersonData }) {
  const t = useT();
  const { locale } = useLocale();
  const router = useRouter();
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const { data: enriched } = useSWR<EnrichedPersonData>(
    `/api/tmdb/person/${id}/enriched`,
    fetcher,
    { revalidateOnFocus: false }
  );

  const profileUrl = data.profilePath ? `${TMDB_IMAGE_BASE}/w300${data.profilePath}` : null;
  const movies = data.credits.filter((c) => c.mediaType === "movie");
  const tvShows = data.credits.filter((c) => c.mediaType === "tv");
  const photos = enriched?.photos ?? [];
  const bio = selectBio(data.biography, enriched?.wikiBio);
  const bioText = bio?.text ?? null;
  const bioSource = bio?.source ?? "tmdb";

  function formatDate(d: string | null) {
    if (!d) return null;
    // Une date seule (« 1962-07-03 ») se lit à minuit UTC : à l'ouest de Greenwich elle tombait la
    // veille. Prise à midi, aucun fuseau ne la fait changer de jour.
    const at = /^\d{4}-\d{2}-\d{2}$/.test(d) ? new Date(`${d}T12:00:00`) : new Date(d);
    return at.toLocaleDateString(getDateLocale(locale), { year: "numeric", month: "long", day: "numeric" });
  }

  return (
    <div className="mx-auto max-w-6xl">
      <button
        onClick={() => router.back()}
        className="btn btn-ghost btn-sm mb-6"
      >
        <ArrowLeft size={14} /> Retour
      </button>

      <div className="mb-8 flex flex-col gap-6 sm:flex-row sm:gap-8">
        <div className="shrink-0">
          <div className="h-48 w-32 overflow-hidden rounded-xl bg-slate-800 shadow-xl ring-1 ring-white/10 sm:h-64 sm:w-44">
            {profileUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={profileUrl} alt={data.name ?? ""} className="h-full w-full object-cover" />
            ) : (
              <div className="flex h-full items-center justify-center">
                <User size={48} className="text-slate-600" />
              </div>
            )}
          </div>
        </div>

        <div className="min-w-0 flex-1">
          <h1 className="mb-1 text-2xl font-bold text-white font-display">{data.name}</h1>
          <div className="mb-3 flex flex-wrap gap-3 text-sm text-slate-400">
            {data.knownFor && (
              <span className="flex items-center gap-1.5">
                <Briefcase size={13} className="text-slate-500" />
                {data.knownFor}
              </span>
            )}
            {data.birthday && (
              <span className="flex items-center gap-1.5">
                <Calendar size={13} className="text-slate-500" />
                {formatDate(data.birthday)}
                {data.deathday && ` — ${formatDate(data.deathday)}`}
              </span>
            )}
            {data.placeOfBirth && (
              <span className="flex items-center gap-1.5">
                <MapPin size={13} className="text-slate-500" />
                {data.placeOfBirth}
              </span>
            )}
          </div>

          {/* Social links */}
          {(enriched?.instagram || enriched?.imdb || enriched?.wikipedia) && (
            <div className="mb-4 flex flex-wrap gap-2">
              {enriched.instagram && (
                <a href={enriched.instagram} target="_blank" rel="noopener noreferrer"
                  className="flex items-center gap-1.5 rounded-lg border border-pink-500/20 bg-pink-500/10 px-2.5 py-1.5 text-xs font-medium text-pink-300 transition hover:bg-pink-500/20">
                  <InstagramIcon size={12} /> Instagram
                </a>
              )}
              {enriched.imdb && (
                <a href={enriched.imdb} target="_blank" rel="noopener noreferrer"
                  className="flex items-center gap-1.5 rounded-lg border border-amber-500/20 bg-amber-500/10 px-2.5 py-1.5 text-xs font-medium text-amber-300 transition hover:bg-amber-500/20">
                  <Star size={12} /> IMDb
                </a>
              )}
              {enriched.wikipedia && (
                <a href={enriched.wikipedia} target="_blank" rel="noopener noreferrer"
                  className="flex items-center gap-1.5 rounded-lg border border-sky-500/20 bg-sky-500/10 px-2.5 py-1.5 text-xs font-medium text-sky-300 transition hover:bg-sky-500/20">
                  <Globe size={12} /> Wikipédia
                </a>
              )}
            </div>
          )}

          {bioText && <ExpandableBio text={bioText} source={bioSource} />}
        </div>
      </div>

      {/* Photo strip */}
      {photos.length > 0 && (
        <div className="mb-8">
          <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-slate-500">{t('person.photos')}</h2>
          <div className="flex gap-2 overflow-x-auto pb-1">
            {photos.map((src, i) => (
              <button key={src} onClick={() => setLightboxIndex(i)}
                className="relative h-28 w-20 shrink-0 overflow-hidden rounded-lg bg-slate-800 ring-1 ring-white/10 transition hover:ring-white/30 hover:scale-[1.03]">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={src} alt="" className="h-full w-full object-cover" loading="lazy" />
              </button>
            ))}
          </div>
        </div>
      )}

      {movies.length > 0 && (
        <section className="mb-8">
          <h2 className="mb-4 flex items-center gap-2 text-base font-semibold text-white">
            <Film size={15} className="text-accent-400" />
            Films <span className="text-sm font-normal text-slate-500">({movies.length})</span>
          </h2>
          <div className="grid grid-cols-3 gap-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-7 xl:grid-cols-8">
            {movies.map((c) => <CreditCard key={`m-${c.tmdbId}`} c={c} />)}
          </div>
        </section>
      )}

      {tvShows.length > 0 && (
        <section>
          <h2 className="mb-4 flex items-center gap-2 text-base font-semibold text-white">
            <Tv size={15} className="text-accent-400" />
            Séries <span className="text-sm font-normal text-slate-500">({tvShows.length})</span>
          </h2>
          <div className="grid grid-cols-3 gap-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-7 xl:grid-cols-8">
            {tvShows.map((c) => <CreditCard key={`t-${c.tmdbId}`} c={c} />)}
          </div>
        </section>
      )}

      {lightboxIndex !== null && photos.length > 0 && createPortal(
        <div className="fixed inset-0 z-9999 flex items-center justify-center bg-black/90 backdrop-blur-xs" onClick={() => setLightboxIndex(null)}>
          <button onClick={(e) => { e.stopPropagation(); setLightboxIndex((i) => ((i ?? 0) - 1 + photos.length) % photos.length); }}
            aria-label={t('person.prevPhoto')}
            className="btn-overlay absolute left-4 top-1/2 z-10 -translate-y-1/2">
            <ChevronLeft size={20} />
          </button>
          <button onClick={(e) => { e.stopPropagation(); setLightboxIndex((i) => ((i ?? 0) + 1) % photos.length); }}
            aria-label={t('person.nextPhoto')}
            className="btn-overlay absolute right-4 top-1/2 z-10 -translate-y-1/2">
            <ChevronRight size={20} />
          </button>
          <button onClick={() => setLightboxIndex(null)}
            aria-label={t('person.closeAria')}
            className="btn-overlay absolute right-4 top-4 z-10">
            <X size={16} />
          </button>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={photos[lightboxIndex].replace("/w342/", "/w780/")} alt=""
            onClick={(e) => e.stopPropagation()}
            className="max-h-[85vh] max-w-[90vw] rounded-xl object-contain shadow-2xl" />
          <p className="absolute bottom-4 left-1/2 -translate-x-1/2 text-xs text-white/50">{lightboxIndex + 1} / {photos.length}</p>
        </div>,
        document.body
      )}
    </div>
  );
}

export default function PersonPage() {
  const t = useT();
  const { id } = useParams<{ id: string }>();
  const { data, isLoading, error } = useSWR<PersonData>(`/api/tmdb/person/${id}`, fetcher);
  if (isLoading) return <DetailSkeleton />;
  if (error || !data) return <ErrorState message={t("errors.loadFailed")} />;
  return <GenericPersonPage id={id} data={data} />;
}
