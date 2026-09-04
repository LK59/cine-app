"use client";

import { useState } from "react";
import Image from "next/image";
import Link from "next/link";
import useSWR from "swr";
import { fetcher } from "@/lib/swr";
import { Modal } from "@/components/Modal";
import { MediaCard } from "@/components/MediaCard";
import { RatingBadge } from "@/components/RatingBadge";
import {
  Film, Tv, BookCheck, Plus, Loader2, Star, MapPin, Calendar,
  ExternalLink, Globe, ChevronLeft, ChevronRight, X,
} from "lucide-react";
import { InstagramIcon } from "@/components/BrandIcons";
import { TMDB_IMAGE_BASE } from "@/lib/clients/tmdb";
import { useToast } from "@/components/Toast";
import { createPortal } from "react-dom";
import type { EnrichedPersonData } from "@/app/api/tmdb/person/[id]/enriched/route";
import { selectBio } from "@/lib/format";
import { useT, useLocale } from "@/components/TranslationProvider";
import { getDateLocale } from "@/lib/i18n";

interface Credit {
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
  credits: Credit[];
  biography: string | null;
  birthday: string | null;
  deathday: string | null;
  placeOfBirth: string | null;
  knownFor: string | null;
}

function formatDate(iso: string, dateLocale: string): string {
  return new Date(iso).toLocaleDateString(dateLocale, { day: "numeric", month: "long", year: "numeric" });
}

// ─── Lightbox ─────────────────────────────────────────────────────────────────

function PhotoLightbox({ photos, startIndex, onClose }: { photos: string[]; startIndex: number; onClose: () => void }) {
  const [idx, setIdx] = useState(startIndex);
  const prev = () => setIdx((i) => (i - 1 + photos.length) % photos.length);
  const next = () => setIdx((i) => (i + 1) % photos.length);

  return createPortal(
    <div className="fixed inset-0 z-9999 flex items-center justify-center bg-black/90 backdrop-blur-xs" onClick={onClose}>
      <button onClick={(e) => { e.stopPropagation(); prev(); }}
        className="btn-overlay absolute left-4 top-1/2 z-10 -translate-y-1/2">
        <ChevronLeft size={20} />
      </button>
      <button onClick={(e) => { e.stopPropagation(); next(); }}
        className="btn-overlay absolute right-4 top-1/2 z-10 -translate-y-1/2">
        <ChevronRight size={20} />
      </button>
      <button onClick={onClose}
        className="btn btn-ghost btn-icon absolute right-4 top-4 z-10 h-9 w-9">
        <X size={16} />
      </button>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={photos[idx].replace("/w342/", "/w780/")}
        alt=""
        onClick={(e) => e.stopPropagation()}
        className="max-h-[85vh] max-w-[90vw] rounded-xl object-contain shadow-2xl"
      />
      <p className="absolute bottom-4 left-1/2 -translate-x-1/2 text-xs text-white/50">{idx + 1} / {photos.length}</p>
    </div>,
    document.body
  );
}

// ─── Biography with expand ────────────────────────────────────────────────────

function Biography({ text, source }: { text: string; source: "wikipedia" | "tmdb" }) {
  const [expanded, setExpanded] = useState(false);
  const t = useT();
  const limit = 400;
  const truncated = text.length > limit && !expanded;
  return (
    <div>
      <p className="text-sm leading-relaxed text-slate-400">
        {truncated ? text.slice(0, limit).trimEnd() + "…" : text}
      </p>
      <div className="mt-1.5 flex items-center justify-between">
        {text.length > limit && (
          <button onClick={() => setExpanded((v) => !v)} className="btn btn-ghost btn-sm mt-1 text-accent-300">
            {expanded ? t('modals.actor.collapse') : t('modals.actor.readMore')}
          </button>
        )}
        <span className="ml-auto text-[10px] text-slate-600">
          {source === "wikipedia" ? t('modals.actor.sourceWikipedia') : t('modals.actor.sourceTmdb')}
        </span>
      </div>
    </div>
  );
}

// ─── Credit card ──────────────────────────────────────────────────────────────

function CreditCard({ credit, onAdded }: { credit: Credit; onAdded: (tmdbId: number) => void }) {
  const toast = useToast();
  const t = useT();
  const [adding, setAdding] = useState(false);
  const [added, setAdded] = useState(false);
  const isInLib = credit.inLibrary || added;

  async function handleAdd(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    setAdding(true);
    try {
      const res = await fetch("/api/discover/add", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tmdbId: credit.tmdbId, type: credit.mediaType === "movie" ? "movie" : "series" }),
      });
      if (!res.ok) throw new Error();
      setAdded(true);
      onAdded(credit.tmdbId);
      toast.success(t('modals.actor.addedToast', { title: credit.title }));
    } catch {
      toast.error(t('modals.actor.addErrorToast'));
    } finally {
      setAdding(false);
    }
  }

  const inner = (
    <MediaCard
      posterUrl={credit.posterPath ? `${TMDB_IMAGE_BASE}/w185${credit.posterPath}` : null}
      alt={credit.title}
      overlay={
        <>
          {isInLib && (
            <div className="absolute right-1.5 top-1.5 flex items-center gap-1 rounded-sm bg-emerald-600/90 px-1.5 py-0.5 text-[10px] font-semibold text-white">
              <BookCheck size={9} /> {t('modals.actor.libraryBadge')}
            </div>
          )}
          <RatingBadge value={credit.voteAverage} className="absolute bottom-1.5 left-1.5" />
        </>
      }
    >
      <div className="flex flex-1 flex-col gap-1.5 p-2">
        <p className="line-clamp-2 text-xs font-medium leading-snug text-white">{credit.title}</p>
        {credit.year && <p className="text-[11px] text-slate-500">{credit.year}</p>}
        {credit.character && <p className="line-clamp-1 text-[10px] italic text-slate-600">{credit.character}</p>}
        {!isInLib && (
          <button onClick={handleAdd} disabled={adding}
            className="btn btn-ghost btn-sm btn-on mt-auto w-full">
            {adding ? <Loader2 size={11} className="animate-spin" /> : <Plus size={11} />}
            {adding ? t('modals.actor.adding') : t('modals.actor.add')}
          </button>
        )}
      </div>
    </MediaCard>
  );

  if (isInLib && credit.libraryHref) {
    return <Link href={credit.libraryHref} onClick={(e) => e.stopPropagation()}>{inner}</Link>;
  }
  return inner;
}

// ─── Main modal ───────────────────────────────────────────────────────────────

export function ActorModal({
  tmdbPersonId,
  name,
  photoUrl,
  onClose,
}: {
  tmdbPersonId: number;
  name: string;
  photoUrl: string | null;
  onClose: () => void;
}) {
  const t = useT();
  const { locale } = useLocale();
  const dateLocale = getDateLocale(locale);
  const [addedIds, setAddedIds] = useState<Set<number>>(new Set());
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);

  const { data, isLoading } = useSWR<PersonData>(
    `/api/tmdb/person/${tmdbPersonId}`,
    fetcher,
    { revalidateOnFocus: false }
  );
  const { data: enriched } = useSWR<EnrichedPersonData>(
    `/api/tmdb/person/${tmdbPersonId}/enriched`,
    fetcher,
    { revalidateOnFocus: false }
  );

  const credits = data?.credits ?? [];
  const library = credits.filter((c) => c.inLibrary || addedIds.has(c.tmdbId));
  const discover = credits.filter((c) => !c.inLibrary && !addedIds.has(c.tmdbId));
  const photos = enriched?.photos ?? [];
  const bio = selectBio(data?.biography, enriched?.wikiBio);
  const bioText = bio?.text ?? null;
  const bioSource = bio?.source ?? "tmdb";

  const [now] = useState(() => Date.now());
  const age = data?.birthday
    ? Math.floor(
        (new Date(data.deathday ?? now).getTime() - new Date(data.birthday).getTime()) /
          (365.25 * 24 * 3600 * 1000)
      )
    : null;

  return (
    <>
      <Modal title={name} onClose={onClose} wide>
        {/* ── Header ── */}
        <div className="mb-4 flex items-start gap-4">
          {photoUrl ? (
            <Image src={photoUrl} alt={name} width={72} height={72} className="rounded-full object-cover ring-2 ring-white/10 shrink-0" />
          ) : (
            <div className="h-[72px] w-[72px] rounded-full bg-slate-800 ring-2 ring-white/10 shrink-0" />
          )}
          <div className="min-w-0 flex-1">
            <p className="font-semibold text-white">{name}</p>
            {data?.knownFor && <p className="mb-1 text-xs text-slate-500">{data.knownFor}</p>}
            <div className="flex flex-wrap gap-x-4 gap-y-1">
              {data?.birthday && (
                <span className="flex items-center gap-1.5 text-xs text-slate-400">
                  <Calendar size={11} className="shrink-0 text-slate-500" />
                  {formatDate(data.birthday, dateLocale)}
                  {age !== null && (
                    <span className="text-slate-500">
                      {data.deathday ? `— ${t('modals.actor.died', { date: formatDate(data.deathday, dateLocale), n: age })}` : `(${t('modals.actor.age', { n: age })})`}
                    </span>
                  )}
                </span>
              )}
              {data?.placeOfBirth && (
                <span className="flex items-center gap-1.5 text-xs text-slate-400">
                  <MapPin size={11} className="shrink-0 text-slate-500" />
                  {data.placeOfBirth}
                </span>
              )}
            </div>
            <p className="mt-1 text-xs text-slate-500">{credits.length > 0 ? t('modals.actor.works', { n: credits.length }) : ""}</p>
          </div>
        </div>

        {/* ── Social links ── */}
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

        {/* ── Photo strip ── */}
        {photos.length > 0 && (
          <div className="mb-4">
            <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-slate-500">{t('modals.actor.photos')}</p>
            <div className="flex gap-2 overflow-x-auto pb-1 [touch-action:pan-x] snap-x snap-mandatory">
              {photos.map((src, i) => (
                <button key={src} onClick={() => setLightboxIndex(i)}
                  className="relative h-24 w-16 shrink-0 overflow-hidden rounded-lg bg-slate-800 ring-1 ring-white/10 transition hover:ring-white/30 hover:scale-[1.03]">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={src} alt="" className="h-full w-full object-cover" loading="lazy" />
                </button>
              ))}
            </div>
          </div>
        )}

        {/* ── Biography ── */}
        {bioText && (
          <div className="mb-5 rounded-lg bg-slate-800/50 p-3">
            <Biography text={bioText} source={bioSource} />
          </div>
        )}

        {isLoading && (
          <div className="flex items-center gap-2 py-8 text-sm text-slate-400">
            <Loader2 size={16} className="animate-spin" /> {t('modals.actor.loadingFilmography')}
          </div>
        )}

        {!isLoading && credits.length === 0 && (
          <p className="py-6 text-center text-sm text-slate-500">{t('modals.actor.noCredits')}</p>
        )}

        {library.length > 0 && (
          <div className="mb-5">
            <h3 className="mb-3 flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-emerald-400">
              <BookCheck size={13} /> {t('modals.actor.inLibrary')}
            </h3>
            <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 md:grid-cols-5">
              {library.map((c) => (
                <CreditCard key={`${c.mediaType}:${c.tmdbId}`} credit={c} onAdded={(id) => setAddedIds((p) => new Set(p).add(id))} />
              ))}
            </div>
          </div>
        )}

        {discover.length > 0 && (
          <div>
            <h3 className="mb-3 flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-slate-400">
              <Film size={13} /> {t('modals.actor.onTmdb')}
            </h3>
            <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 md:grid-cols-5">
              {discover.map((c) => (
                <CreditCard key={`${c.mediaType}:${c.tmdbId}`} credit={c} onAdded={(id) => setAddedIds((p) => new Set(p).add(id))} />
              ))}
            </div>
          </div>
        )}
      </Modal>

      {lightboxIndex !== null && photos.length > 0 && (
        <PhotoLightbox photos={photos} startIndex={lightboxIndex} onClose={() => setLightboxIndex(null)} />
      )}
    </>
  );
}
