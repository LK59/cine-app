"use client";

import Link from "next/link";
import { useRouter, useParams } from "next/navigation";
import useSWR from "swr";
import { fetcher } from "@/lib/swr";
import { LoadingState, ErrorState } from "@/components/StateViews";
import { WatchlistButton } from "@/components/WatchlistButton";
import { TMDB_IMAGE_BASE } from "@/lib/clients/tmdb";
import {
  ArrowLeft, Star, Film, Tv, BookCheck, User, Calendar, MapPin, Briefcase,
  ExternalLink, X, ChevronLeft, ChevronRight, Globe, CirclePlus,
} from "lucide-react";
import { useState, useEffect, useCallback, useMemo } from "react";
import { createPortal } from "react-dom";
import type { VipPerson } from "@/lib/vip-persons";
import { isVip, isClaraGalleryEnabled } from "@/lib/vip-persons";
import type { NewsArticle } from "@/app/api/news/clara/route";
import type { EnrichedPersonData } from "@/app/api/tmdb/person/[id]/enriched/route";
import type { PersonPhoto } from "@/app/api/tmdb/person/[id]/photos/route";
import { HorizontalCarousel } from "@/components/HorizontalCarousel";
import { selectBio } from "@/lib/format";
import { InstagramIcon } from "@/components/BrandIcons";
import { apiAction } from "@/lib/apiAction";
import { useT } from "@/components/TranslationProvider";
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
  async function doRequest(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    setRequesting(true);
    try {
      await apiAction("/api/jellyseerr/requests", {
        method: "POST",
        body: JSON.stringify({ mediaType: c.mediaType === "movie" ? "movie" : "tv", mediaId: c.tmdbId }),
      });
      setRequested(true);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('common.error'));
    } finally {
      setRequesting(false);
    }
  }

  const content = (
    <div className="card group flex flex-col overflow-hidden">
      <div className="relative aspect-2/3 shrink-0 bg-slate-800">
        {poster ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={poster} alt={c.title} className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-105" />
        ) : (
          <div className="flex h-full items-center justify-center">
            {c.mediaType === "movie" ? <Film size={32} className="text-slate-700" /> : <Tv size={32} className="text-slate-700" />}
          </div>
        )}
        {c.inLibrary && (
          <div className="absolute right-1.5 top-1.5 rounded-sm bg-emerald-600/90 p-1">
            <BookCheck size={9} className="text-white" />
          </div>
        )}
        {c.voteAverage > 0 && (
          <div className="absolute bottom-1.5 left-1.5 flex items-center gap-0.5 rounded-sm bg-black/70 px-1.5 py-0.5 text-[10px] font-semibold text-amber-400">
            <Star size={8} className="fill-amber-400" />
            {c.voteAverage.toFixed(1)}
          </div>
        )}
        {!c.inLibrary && (
          <div className="absolute inset-0 flex flex-col justify-end bg-linear-to-t from-slate-900/95 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity p-2 gap-1.5">
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
      </div>
      <div className="flex flex-1 flex-col gap-1 p-2">
        <p className="line-clamp-2 text-xs font-medium leading-snug text-white">{c.title}</p>
        {c.character && <p className="line-clamp-1 text-[11px] text-slate-500 italic">{c.character}</p>}
        {c.year && <p className="text-[11px] text-slate-600">{c.year}</p>}
      </div>
    </div>
  );

  if (c.libraryHref) return <Link href={c.libraryHref}>{content}</Link>;
  return content;
}

// ─── Gallery lightbox ─────────────────────────────────────────────────────────

function GalleryLightbox({
  files,
  startIndex,
  onClose,
}: {
  files: string[];
  startIndex: number;
  onClose: () => void;
}) {
  const t = useT();
  const [idx, setIdx] = useState(startIndex);
  const [mounted, setMounted] = useState(false);

  // Starts false so the entrance transition has an initial (hidden) state to animate from —
  // flipping it true must happen post-paint, in an effect, not during render.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => setMounted(true), []);
  // Adjusts state from the startIndex prop during render (not in an effect) per React's
  // guidance for this pattern, to avoid an extra render pass.
  const [resetForStartIndex, setResetForStartIndex] = useState(startIndex);
  if (startIndex !== resetForStartIndex) {
    setResetForStartIndex(startIndex);
    setIdx(startIndex);
  }

  const prev = useCallback(() => setIdx((i) => (i - 1 + files.length) % files.length), [files.length]);
  const next = useCallback(() => setIdx((i) => (i + 1) % files.length), [files.length]);

  useEffect(() => {
    function handler(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
      if (e.key === "ArrowLeft") prev();
      if (e.key === "ArrowRight") next();
    }
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onClose, prev, next]);

  if (files.length === 0 || !mounted) return null;

  return createPortal(
    <div className="fixed inset-0 z-9999 grid place-items-center overflow-hidden bg-[#05040a]/95 p-4 backdrop-blur-xl sm:p-6 lg:p-8" onClick={onClose}>
      <div className="pointer-events-none absolute inset-x-0 top-0 h-40 bg-linear-to-b from-amber-400/10 to-transparent" />
      <button
        onClick={(e) => { e.stopPropagation(); prev(); }}
        aria-label={t('person.prevPhoto')}
        className="btn-overlay absolute left-3 top-1/2 z-10 -translate-y-1/2 sm:left-6"
      >
        <ChevronLeft size={24} />
      </button>
      <button
        onClick={(e) => { e.stopPropagation(); next(); }}
        aria-label={t('person.nextPhoto')}
        className="btn-overlay absolute right-3 top-1/2 z-10 -translate-y-1/2 sm:right-6"
      >
        <ChevronRight size={24} />
      </button>
      <button
        onClick={onClose}
        aria-label={t('person.closeAria')}
        className="btn-overlay absolute right-3 top-3 z-10 sm:right-6 sm:top-6"
      >
        <X size={20} />
      </button>
      <figure className="relative grid max-h-[calc(100vh-2rem)] w-full max-w-[min(92vw,1280px)] place-items-center gap-4" onClick={(e) => e.stopPropagation()}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={"/api/gallery/clara/" + encodeURIComponent(files[idx])}
          alt={"Photo " + (idx + 1)}
          className="max-h-[calc(100vh-7rem)] max-w-full rounded-2xl object-contain shadow-[0_30px_90px_rgba(0,0,0,0.65)] ring-1 ring-white/10"
          decoding="async"
        />
        <figcaption className="rounded-full border border-white/10 bg-white/10 px-4 py-1.5 text-xs font-medium text-white/75 backdrop-blur-md">
          {idx + 1} / {files.length}
        </figcaption>
      </figure>
    </div>,
    document.body,
  );
}

// â”€â”€â”€ VIP page â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

// ─── VIP timeline & quotes ────────────────────────────────────────────────────

function TimelineSection({ items }: { items: NonNullable<import("@/lib/vip-persons").VipPerson["timeline"]> }) {
  const t = useT();
  const tagColors: Record<string, string> = {
    Netflix: "bg-red-500/20 text-red-300 border-red-500/30",
    Série: "bg-violet-500/20 text-violet-300 border-violet-500/30",
    Clip: "bg-pink-500/20 text-pink-300 border-pink-500/30",
    Formation: "bg-sky-500/20 text-sky-300 border-sky-500/30",
    Publicité: "bg-emerald-500/20 text-emerald-300 border-emerald-500/30",
    Tournage: "bg-orange-500/20 text-orange-300 border-orange-500/30",
  };
  return (
    <section className="mb-16">
      <div className="mb-8">
        <p className="text-xs font-semibold uppercase tracking-[0.24em] text-amber-200/70">{t('person.career')}</p>
        <h2 className="mt-2 text-3xl font-bold text-white font-display">{t('person.careerSection')}</h2>
      </div>
      <div className="relative ml-4 border-l border-white/10 pl-8 sm:ml-8 sm:pl-10">
        {items.map((item, i) => (
          <div key={i} className="group relative mb-8 last:mb-0">
            <div className="absolute left-[-2.6rem] top-1.5 flex h-4 w-4 items-center justify-center rounded-full border-2 border-amber-300/60 bg-[#050712] transition group-hover:border-amber-300 group-hover:bg-amber-300/20 sm:left-[-2.8rem]" />
            <div className="rounded-2xl border border-white/10 bg-white/4 p-4 transition hover:border-white/20 hover:bg-white/[0.07] sm:p-5">
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <span className="text-xs font-semibold text-amber-200/80">{item.date}</span>
                {item.tag && (
                  <span className={["rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide", tagColors[item.tag] ?? "bg-white/10 text-white/60 border-white/10"].join(" ")}>
                    {item.tag}
                  </span>
                )}
              </div>
              <p className="text-sm font-bold text-white sm:text-base">{item.event}</p>
              {item.detail && <p className="mt-1 text-sm leading-6 text-white/55">{item.detail}</p>}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function QuotesSection({ quotes }: { quotes: NonNullable<import("@/lib/vip-persons").VipPerson["quotes"]> }) {
  return (
    <section className="mb-16">
      <div className="mb-8">
        <p className="text-xs font-semibold uppercase tracking-[0.24em] text-amber-200/70">En sus palabras</p>
        <h2 className="mt-2 text-3xl font-bold text-white font-display">Citas</h2>
      </div>
      <div className="grid gap-4 lg:grid-cols-3">
        {quotes.map((q, i) => (
          <blockquote key={i} className="relative rounded-2xl border border-white/10 bg-white/4 p-6">
            <span className="absolute -top-3 left-5 font-serif text-5xl leading-none text-amber-300/40 select-none font-display">&ldquo;</span>
            <p className="relative text-sm italic leading-8 text-slate-200/85 sm:text-base">{q.text}</p>
            {q.context && <footer className="mt-4 text-xs text-white/35">— {q.context}</footer>}
          </blockquote>
        ))}
      </div>
    </section>
  );
}

// ─── VIP sub-components ───────────────────────────────────────────────────────

function VideoCard({ videoId, title }: { videoId: string; title: string }) {
  const [playing, setPlaying] = useState(false);
  const [thumbSrc, setThumbSrc] = useState(`https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`);

  return (
    <div className="group relative aspect-video overflow-hidden rounded-2xl bg-slate-900 shadow-xl ring-1 ring-white/10">
      {playing ? (
        <iframe
          src={`https://www.youtube.com/embed/${videoId}?autoplay=1&rel=0`}
          title={title}
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
          allowFullScreen
          className="absolute inset-0 h-full w-full"
        />
      ) : (
        <button onClick={() => setPlaying(true)} className="absolute inset-0 h-full w-full" aria-label={"Lire " + title}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={thumbSrc}
            alt={title}
            className="h-full w-full object-cover transition duration-500 group-hover:scale-105"
            loading="lazy"
            decoding="async"
            onError={() => setThumbSrc(`https://img.youtube.com/vi/${videoId}/hqdefault.jpg`)}
          />
          <div className="absolute inset-0 bg-black/30 transition group-hover:bg-black/20" />
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="flex h-16 w-16 items-center justify-center rounded-full bg-red-600 shadow-2xl shadow-red-600/40 transition group-hover:scale-110">
              <svg viewBox="0 0 24 24" fill="white" className="ml-1 h-7 w-7"><path d="M8 5v14l11-7z"/></svg>
            </div>
          </div>
        </button>
      )}
    </div>
  );
}

function NewsSection() {
  const t = useT();
  const { data } = useSWR<{ articles: NewsArticle[] }>(
    "/api/news/clara",
    fetcher,
    { revalidateOnFocus: false, shouldRetryOnError: false }
  );
  const articles = data?.articles ?? [];
  if (!data || articles.length === 0) return null;

  return (
    <section className="mb-10">
      <div className="mb-6">
        <p className="text-xs font-semibold uppercase tracking-[0.24em] text-amber-200/70">Presse</p>
        <h2 className="mt-2 text-3xl font-bold text-white font-display">{t('person.news')}</h2>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {articles.map((a, i) => {
          const date = a.pubDate ? new Date(a.pubDate).toLocaleDateString("fr-FR", { day: "numeric", month: "short", year: "numeric" }) : null;
          return (
            <a
              key={i}
              href={a.link}
              target="_blank"
              rel="noopener noreferrer"
              className="group flex flex-col justify-between gap-3 rounded-2xl border border-white/10 bg-white/5 p-4 transition hover:border-amber-200/30 hover:bg-white/9"
            >
              <p className="line-clamp-3 text-sm font-medium leading-6 text-white/90 group-hover:text-white">{a.title}</p>
              <div className="flex items-center justify-between text-xs text-white/40">
                <span>{a.source}</span>
                {date && <span>{date}</span>}
              </div>
            </a>
          );
        })}
      </div>
      <div className="mt-4 flex justify-end">
        <a
          href="https://news.google.com/search?q=Clara+Galle&hl=fr"
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-2 text-xs text-white/40 transition hover:text-white/70"
        >
          Voir plus sur Google News <ExternalLink size={12} />
        </a>
      </div>
    </section>
  );
}

// ─────────────────────────────────────────────────────────────────────────────

type Lang = "fr" | "es" | "en";

function VipPersonPage({ id, data }: { id: string; data: PersonData }) {
  const t = useT();
  const router = useRouter();
  const { data: vip } = useSWR<VipPerson>(`/api/vip/${id}`, fetcher, { revalidateOnFocus: false });
  const { data: galleryData } = useSWR<{ files: string[] }>("/api/gallery/clara", fetcher, { revalidateOnFocus: false });
  // Shuffling uses Math.random(), which isn't pure — it belongs in an effect, not a render-time
  // useMemo (which React may invoke more than once per commit).
  const [files, setFiles] = useState<string[]>([]);
  useEffect(() => {
    const arr = (galleryData?.files ?? []).filter((file) => file !== "clarabanner.jpg");
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setFiles(arr);
  }, [galleryData]);

  const { data: tmdbPhotosData } = useSWR<{ photos: PersonPhoto[] }>(
    `/api/tmdb/person/${id}/photos`,
    fetcher,
    { revalidateOnFocus: false, shouldRetryOnError: false }
  );
  const tmdbPhotos = tmdbPhotosData?.photos ?? [];

  const [lang, setLang] = useState<Lang>("fr");
  const [photoLimit, setPhotoLimit] = useState(18);
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const [tmdbPhotoIndex, setTmdbPhotoIndex] = useState<number | null>(null);

  const visibleFiles = files.slice(0, photoLimit);
  const hasMorePhotos = photoLimit < files.length;
  const bannerFile = "clarabanner.jpg";
  const profileUrl = data.profilePath ? TMDB_IMAGE_BASE + "/h632" + data.profilePath : null;
  const bannerUrl = "/api/gallery/clara/" + encodeURIComponent(bannerFile);
  const collageFiles = files.slice(0, 6);

  const movies = data.credits.filter((c) => c.mediaType === "movie");
  const tvShows = data.credits.filter((c) => c.mediaType === "tv");

  const bioText = vip?.bio[lang] ?? "";
  const bioParagraphs = bioText.split("\n\n").filter(Boolean);

  const langLabels: Record<Lang, string> = { fr: "Francais", es: "Espanol", en: "English" };
  const primaryPhoto = files[0] ? "/api/gallery/clara/" + encodeURIComponent(files[0]) : profileUrl;

  return (
    <div className="min-h-screen overflow-hidden bg-[#050712] text-white">
      <section className="relative isolate min-h-[720px] overflow-hidden pb-16 sm:min-h-[760px] lg:min-h-[820px] 2xl:min-h-[880px]">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={bannerUrl} alt="Clara Galle" className="absolute inset-0 -z-30 h-full w-full object-cover object-[50%_16%]" />
        <div className="absolute inset-0 -z-20 bg-[radial-gradient(circle_at_75%_18%,rgba(250,204,21,0.18),transparent_30%),linear-gradient(90deg,rgba(5,7,18,0.95)_0%,rgba(5,7,18,0.68)_40%,rgba(5,7,18,0.38)_100%)]" />
        <div className="absolute inset-x-0 bottom-0 -z-10 h-72 bg-linear-to-t from-[#050712] via-[#050712]/90 to-transparent" />

        <button
          onClick={() => router.back()}
          className="btn-overlay absolute left-4 top-4 z-20 gap-2 px-4 sm:left-8 sm:top-8"
        >
          <ArrowLeft size={15} /> Retour
        </button>

        <div className="mx-auto grid min-h-[680px] max-w-[1720px] grid-cols-1 items-end gap-8 px-4 pb-10 pt-24 sm:min-h-[720px] sm:px-6 lg:min-h-[800px] lg:grid-cols-[minmax(0,1fr)_500px] lg:px-10 lg:pb-16 lg:pt-24 2xl:grid-cols-[minmax(0,1fr)_560px] 2xl:px-14">
          <div className="max-w-4xl">
            <h1 className="text-5xl font-black leading-[0.92] tracking-normal text-white drop-shadow-2xl sm:text-7xl lg:text-8xl font-display">
              Clara<br />Galle
            </h1>
            <div className="mt-6 flex flex-wrap gap-3 text-sm text-white/70">
              <span className="flex items-center gap-2 rounded-full border border-white/10 bg-white/10 px-3 py-1.5 backdrop-blur-md">
                <Calendar size={14} className="text-amber-200" /> 15 avril 2002
              </span>
              <span className="flex items-center gap-2 rounded-full border border-white/10 bg-white/10 px-3 py-1.5 backdrop-blur-md">
                <MapPin size={14} className="text-amber-200" /> Née à Pampelune
              </span>
              <span className="flex items-center gap-2 rounded-full border border-white/10 bg-white/10 px-3 py-1.5 backdrop-blur-md">
                <Briefcase size={14} className="text-amber-200" /> Actrice
              </span>
            </div>
            <p className="mt-6 max-w-2xl text-base leading-8 text-white/70 sm:text-lg">
              Actrice et mannequin espagnole, révélée par la trilogie Netflix <em>À travers ma fenêtre</em> et à l&apos;affiche de la série <em>Olympo</em> en 2025.
            </p>
            <div className="mt-8 grid grid-cols-3 gap-2 sm:max-w-xl sm:gap-3">
              <div className="rounded-2xl border border-white/10 bg-white/10 p-4 backdrop-blur-md">
                <p className="text-2xl font-bold text-white font-display">{files.length}</p>
                <p className="mt-1 text-xs uppercase tracking-[0.18em] text-white/50">photos</p>
              </div>
              <div className="rounded-2xl border border-white/10 bg-white/10 p-4 backdrop-blur-md">
                <p className="text-2xl font-bold text-white font-display">{movies.length}</p>
                <p className="mt-1 text-xs uppercase tracking-[0.18em] text-white/50">films</p>
              </div>
              <div className="rounded-2xl border border-white/10 bg-white/10 p-4 backdrop-blur-md">
                <p className="text-2xl font-bold text-white font-display">{tvShows.length}</p>
                <p className="mt-1 text-xs uppercase tracking-[0.18em] text-white/50">series</p>
              </div>
            </div>
            {collageFiles.length > 0 && (
              <div className="mt-6 flex gap-3 overflow-x-auto pb-2 lg:hidden">
                {collageFiles.slice(0, 5).map((file, i) => (
                  <button
                    key={file}
                    onClick={() => setLightboxIndex(files.indexOf(file))}
                    className="h-28 w-24 shrink-0 overflow-hidden rounded-2xl border border-white/20 bg-white/10 shadow-xl"
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={"/api/gallery/clara/" + encodeURIComponent(file) + "?thumb=1"} alt={"Clara " + (i + 1)} className="h-full w-full object-cover" loading="eager" decoding="async" />
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="relative hidden min-h-[500px] lg:block 2xl:min-h-[560px]">
            {primaryPhoto && (
              <div className="absolute bottom-0 right-16 h-[390px] w-[270px] overflow-hidden rounded-4xl border border-white/20 bg-white/10 shadow-[0_40px_100px_rgba(0,0,0,0.55)] backdrop-blur-md 2xl:right-24 2xl:h-[430px] 2xl:w-[300px]">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={primaryPhoto} alt="Clara Galle" className="h-full w-full object-cover" decoding="async" />
              </div>
            )}
            {collageFiles.slice(1, 5).map((file, i) => (
              <button
                key={file}
                onClick={() => setLightboxIndex(files.indexOf(file))}
                className={[
                  "absolute overflow-hidden rounded-2xl border border-white/20 bg-white/10 shadow-2xl transition duration-300 hover:-translate-y-1 hover:scale-[1.03] hover:border-amber-200/50",
                  i === 0 ? "right-0 top-12 h-40 w-28 2xl:h-44 2xl:w-32" : "",
                  i === 1 ? "right-4 top-64 h-32 w-44 2xl:right-8 2xl:h-36 2xl:w-48" : "",
                  i === 2 ? "right-72 top-24 h-28 w-32 2xl:right-80 2xl:h-32 2xl:w-36" : "",
                  i === 3 ? "right-0 bottom-2 h-40 w-32 2xl:h-44 2xl:w-36" : "",
                ].join(" ")}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={"/api/gallery/clara/" + encodeURIComponent(file)} alt={"Clara " + (i + 1)} className="h-full w-full object-cover" loading="eager" decoding="async" />
              </button>
            ))}
          </div>
        </div>
      </section>

      <main className="relative mx-auto max-w-[1720px] px-4 pb-20 sm:px-6 lg:px-10 2xl:px-14">
        <section className="-mt-14 mb-14 grid gap-5 xl:grid-cols-[minmax(0,1fr)_380px] 2xl:grid-cols-[minmax(0,1fr)_420px]">
          <div className="rounded-[1.75rem] border border-white/10 bg-white/[0.07] p-5 shadow-[0_24px_80px_rgba(0,0,0,0.35)] backdrop-blur-xl sm:p-7">
            <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.24em] text-amber-200/80">{t('person.portrait')}</p>
                <h2 className="mt-2 text-2xl font-bold text-white font-display">{t('person.biography')}</h2>
              </div>
              <div className="grid grid-cols-3 rounded-full border border-white/10 bg-black/20 p-1">
                {(["fr", "es", "en"] as Lang[]).map((l) => (
                  <button
                    key={l}
                    onClick={() => setLang(l)}
                    className={[
                      "rounded-full px-3 py-2 text-xs font-semibold transition",
                      lang === l ? "bg-amber-300 text-ink shadow-lg shadow-amber-300/20" : "text-white/55 hover:text-white",
                    ].join(" ")}
                  >
                    {langLabels[l]}
                  </button>
                ))}
              </div>
            </div>
            <div className="space-y-5 text-[15px] leading-8 text-slate-200/90 sm:text-base">
              {bioParagraphs.map((p, i) => (
                <p key={i}>{p}</p>
              ))}
            </div>
          </div>

          <aside className="rounded-[1.75rem] border border-white/10 bg-[#0b1020]/80 p-5 shadow-[0_24px_80px_rgba(0,0,0,0.35)] backdrop-blur-xl sm:p-6">
            <div className="flex items-center gap-4">
              <div className="rounded-full bg-linear-to-br from-amber-200 via-yellow-400 to-rose-300 p-[3px] shadow-[0_0_34px_rgba(250,204,21,0.35)]">
                <div className="h-24 w-24 overflow-hidden rounded-full bg-slate-900 ring-4 ring-[#0b1020]">
                  {profileUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={profileUrl} alt="Clara Galle" className="h-full w-full object-cover object-[50%_20%]" decoding="async" />
                  ) : (
                    <div className="flex h-full items-center justify-center"><User size={34} className="text-slate-600" /></div>
                  )}
                </div>
              </div>
              <div className="min-w-0">
                <p className="text-sm font-semibold text-white">Clara Galle</p>
                <p className="mt-1 text-sm text-white/50">Liens officiels et ressources</p>
              </div>
            </div>
            <div className="mt-6 grid gap-2">
              {vip?.links.instagram && (
                <a href={vip.links.instagram} target="_blank" rel="noopener noreferrer" className="flex items-center justify-between rounded-2xl border border-pink-300/20 bg-pink-300/10 px-4 py-3 text-sm font-semibold text-pink-100 transition hover:bg-pink-300/20">
                  <span className="flex items-center gap-3"><InstagramIcon size={16} /> Instagram</span><ExternalLink size={14} />
                </a>
              )}
              {vip?.links.tiktok && (
                <a href={vip.links.tiktok} target="_blank" rel="noopener noreferrer" className="flex items-center justify-between rounded-2xl border border-slate-300/20 bg-slate-300/10 px-4 py-3 text-sm font-semibold text-slate-100 transition hover:bg-slate-300/20">
                  <span className="flex items-center gap-3">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M19.59 6.69a4.83 4.83 0 0 1-3.77-4.25V2h-3.45v13.67a2.89 2.89 0 0 1-2.88 2.5 2.89 2.89 0 0 1-2.89-2.89 2.89 2.89 0 0 1 2.89-2.89c.28 0 .54.04.79.1V9.01a6.33 6.33 0 0 0-.79-.05 6.34 6.34 0 0 0-6.34 6.34 6.34 6.34 0 0 0 6.34 6.34 6.34 6.34 0 0 0 6.33-6.34V8.69a8.22 8.22 0 0 0 4.81 1.54V6.78a4.85 4.85 0 0 1-1.04-.09z"/></svg>
                    TikTok
                  </span><ExternalLink size={14} />
                </a>
              )}
              {vip?.links.imdb && (
                <a href={vip.links.imdb} target="_blank" rel="noopener noreferrer" className="flex items-center justify-between rounded-2xl border border-amber-300/20 bg-amber-300/10 px-4 py-3 text-sm font-semibold text-amber-100 transition hover:bg-amber-300/20">
                  <span className="flex items-center gap-3"><Star size={16} /> IMDb</span><ExternalLink size={14} />
                </a>
              )}
              {vip?.links.wikipedia && (
                <a href={vip.links.wikipedia} target="_blank" rel="noopener noreferrer" className="flex items-center justify-between rounded-2xl border border-sky-300/20 bg-sky-300/10 px-4 py-3 text-sm font-semibold text-sky-100 transition hover:bg-sky-300/20">
                  <span className="flex items-center gap-3"><Globe size={16} /> Wikipedia</span><ExternalLink size={14} />
                </a>
              )}
              {vip?.links.agency && (
                <a href={vip.links.agency} target="_blank" rel="noopener noreferrer" className="flex items-center justify-between rounded-2xl border border-violet-300/20 bg-violet-300/10 px-4 py-3 text-sm font-semibold text-violet-100 transition hover:bg-violet-300/20">
                  <span className="flex items-center gap-3"><Briefcase size={16} /> CRAM Talent</span><ExternalLink size={14} />
                </a>
              )}
            </div>
          </aside>
        </section>

        {files.length > 0 && (
          <section className="mb-16">
            <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.24em] text-amber-200/70">Galerie</p>
                <h2 className="mt-2 text-3xl font-bold text-white font-display">Galería</h2>

              </div>
              <p className="text-sm font-medium text-white/50">{visibleFiles.length} / {files.length} visibles</p>
            </div>
            <div className="grid auto-rows-[120px] grid-cols-2 gap-2 sm:auto-rows-[150px] sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 2xl:auto-rows-[180px] 2xl:grid-cols-8">
              {visibleFiles.map((file, i) => (
                <button
                  key={file}
                  onClick={(e) => { e.currentTarget.scrollIntoView({ block: "center", inline: "center", behavior: "smooth" }); setLightboxIndex(i); }}
                  className={[
                    "group relative overflow-hidden rounded-2xl bg-slate-900 shadow-xl ring-1 ring-white/10 transition duration-300 hover:-translate-y-1 hover:ring-amber-200/60",
                    i % 11 === 0 ? "col-span-2 row-span-2" : "",
                    i % 11 === 5 ? "row-span-2" : "",
                    i % 11 === 8 ? "col-span-2" : "",
                  ].join(" ")}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={"/api/gallery/clara/" + encodeURIComponent(file) + "?thumb=1"}
                    alt=""
                    className="h-full w-full object-cover transition duration-500 group-hover:scale-105"
                    loading={i < 6 ? "eager" : "lazy"}
                    decoding="async"
                  />
                </button>
              ))}
            </div>
            {hasMorePhotos && (
              <div className="mt-6 flex flex-col gap-3 sm:flex-row">
                <button
                  onClick={() => setPhotoLimit((value) => Math.min(value + 24, files.length))}
                  className="rounded-2xl border border-amber-200/20 bg-amber-200/10 px-5 py-3 text-sm font-semibold text-amber-100 transition hover:bg-amber-200/20"
                >
                  Charger 24 photos de plus
                </button>
                <button
                  onClick={() => setPhotoLimit(files.length)}
                  className="rounded-2xl border border-white/10 bg-white/5 px-5 py-3 text-sm font-semibold text-white/70 transition hover:bg-white/10 hover:text-white"
                >
                  Tout afficher
                </button>
              </div>
            )}
          </section>
        )}

        {tmdbPhotos.length > 0 && (
          <section className="mb-10">
            <div className="mb-4">
              <p className="text-xs font-semibold uppercase tracking-[0.24em] text-amber-200/70">TMDb</p>
              <h2 className="mt-1 text-2xl font-bold text-white font-display">{t('person.photos')}</h2>
            </div>
            <HorizontalCarousel className="scrollbar-thin flex gap-3 overflow-x-auto pb-3 snap-x snap-mandatory">
              {tmdbPhotos.map((photo, i) => (
                <button
                  key={photo.filePath}
                  onClick={() => setTmdbPhotoIndex(i)}
                  className="group snap-start shrink-0 overflow-hidden rounded-xl ring-1 ring-white/10 transition hover:-translate-y-0.5 hover:ring-amber-200/40"
                  style={{ width: photo.aspectRatio > 1 ? 200 : 112 }}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={photo.filePath}
                    alt={`Photo ${i + 1}`}
                    className="h-40 w-full object-cover transition duration-300 group-hover:scale-105"
                    loading={i < 6 ? "eager" : "lazy"}
                  />
                </button>
              ))}
            </HorizontalCarousel>
          </section>
        )}

        {vip?.quotes && vip.quotes.length > 0 && (
          <QuotesSection quotes={vip.quotes} />
        )}

        {vip?.timeline && vip.timeline.length > 0 && (
          <TimelineSection items={vip.timeline} />
        )}

        {movies.length > 0 && (
          <section className="mb-10">
            <h2 className="mb-5 flex items-center gap-2 text-xl font-bold text-white">
              <Film size={18} className="text-amber-200" /> Films <span className="text-sm font-normal text-white/40">({movies.length})</span>
            </h2>
            <div className="grid grid-cols-3 gap-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-7 xl:grid-cols-8">
              {movies.map((c) => <CreditCard key={"m-" + c.tmdbId} c={c} />)}
            </div>
          </section>
        )}

        {tvShows.length > 0 && (
          <section className="mb-16">
            <h2 className="mb-5 flex items-center gap-2 text-xl font-bold text-white">
              <Tv size={18} className="text-amber-200" /> Series <span className="text-sm font-normal text-white/40">({tvShows.length})</span>
            </h2>
            <div className="grid grid-cols-3 gap-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-7 xl:grid-cols-8">
              {tvShows.map((c) => <CreditCard key={"t-" + c.tmdbId} c={c} />)}
            </div>
          </section>
        )}

        {vip?.videos && vip.videos.length > 0 && (
          <section className="mb-16">
            <div className="mb-6">
              <p className="text-xs font-semibold uppercase tracking-[0.24em] text-amber-200/70">Médias</p>
              <h2 className="mt-2 text-3xl font-bold text-white font-display">{t('person.interviewsVideos')}</h2>
            </div>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {vip.videos.map((v) => <VideoCard key={v.id} videoId={v.id} title={v.title} />)}
            </div>
          </section>
        )}

        <NewsSection />
      </main>

      {lightboxIndex !== null && (
        <GalleryLightbox
          files={files}
          startIndex={lightboxIndex}
          onClose={() => setLightboxIndex(null)}
        />
      )}
      {tmdbPhotoIndex !== null && tmdbPhotos.length > 0 &&
        createPortal(
          <TmdbPhotoLightbox
            photos={tmdbPhotos}
            startIndex={tmdbPhotoIndex}
            onClose={() => setTmdbPhotoIndex(null)}
          />,
          document.body
        )
      }
    </div>
  );
}

function TmdbPhotoLightbox({ photos, startIndex, onClose }: { photos: PersonPhoto[]; startIndex: number; onClose: () => void }) {
  const t = useT();
  const [idx, setIdx] = useState(startIndex);
  const prev = useCallback(() => setIdx((i) => (i - 1 + photos.length) % photos.length), [photos.length]);
  const next = useCallback(() => setIdx((i) => (i + 1) % photos.length), [photos.length]);
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); if (e.key === "ArrowLeft") prev(); if (e.key === "ArrowRight") next(); };
    document.addEventListener("keydown", h);
    return () => document.removeEventListener("keydown", h);
  }, [onClose, prev, next]);
  return (
    <div className="fixed inset-0 z-9999 grid place-items-center overflow-hidden bg-[#05040a]/95 p-4 backdrop-blur-xl sm:p-6" onClick={onClose}>
      <button onClick={(e) => { e.stopPropagation(); prev(); }} aria-label={t('person.prevPhoto')} className="btn-overlay absolute left-3 top-1/2 z-10 -translate-y-1/2 sm:left-6"><ChevronLeft size={24} /></button>
      <button onClick={(e) => { e.stopPropagation(); next(); }} aria-label={t('person.nextPhoto')} className="btn-overlay absolute right-3 top-1/2 z-10 -translate-y-1/2 sm:right-6"><ChevronRight size={24} /></button>
      <button onClick={onClose} aria-label={t('person.closeAria')} className="btn-overlay absolute right-3 top-3 z-10 sm:right-6 sm:top-6"><X size={20} /></button>
      <figure className="relative grid max-h-[calc(100vh-2rem)] w-full max-w-[min(92vw,1000px)] place-items-center gap-4" onClick={(e) => e.stopPropagation()}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={photos[idx].fullPath} alt={`Photo ${idx + 1}`} className="max-h-[calc(100vh-7rem)] max-w-full rounded-2xl object-contain shadow-[0_30px_90px_rgba(0,0,0,0.65)] ring-1 ring-white/10" decoding="async" />
        <figcaption className="rounded-full border border-white/10 bg-white/10 px-4 py-1.5 text-xs font-medium text-white/75 backdrop-blur-md">{idx + 1} / {photos.length}</figcaption>
      </figure>
    </div>
  );
}

function ExpandableBio({ text, source }: { text: string; source: "wikipedia" | "tmdb" }) {
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
            {expanded ? "Réduire" : "Lire la suite"}
          </button>
        )}
        <span className="text-[10px] text-slate-600">Source : {source === "wikipedia" ? "Wikipédia" : "TMDb"}</span>
      </div>
    </div>
  );
}

function GenericPersonPage({ id, data }: { id: string; data: PersonData }) {
  const t = useT();
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
    return new Date(d).toLocaleDateString("fr-FR", { year: "numeric", month: "long", day: "numeric" });
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

// ─── Router ───────────────────────────────────────────────────────────────────

export default function PersonPage() {
  const { id } = useParams<{ id: string }>();
  const { data, isLoading, error } = useSWR<PersonData>(`/api/tmdb/person/${id}`, fetcher);
  if (isLoading) return <LoadingState label="Chargement de la fiche personne…" />;
  if (error || !data) return <ErrorState message="Impossible de charger cette fiche." />;

  const numId = Number(id);
  if (isVip(numId) && isClaraGalleryEnabled()) {
    return <VipPersonPage id={id} data={data} />;
  }

  return <GenericPersonPage id={id} data={data} />;
}
