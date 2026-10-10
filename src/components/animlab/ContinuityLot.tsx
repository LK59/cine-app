"use client";

import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { ArrowLeft, Bookmark, Check, Play, Video, X } from "lucide-react";
import type { CinemaMovie } from "@/app/api/cinema/movies/route";
import { ImdbBadge } from "@/components/ImdbBadge";
import { CinemaLogo } from "@/components/cinema/CinemaLogo";
import { COLUMN_GAP, COLUMN_STYLE, HORIZONTAL_VEIL, MENU_STYLE, SECTION_CLASS, VERTICAL_VEIL } from "@/components/cinema/CinemaDetailLayout";
import { MENU_BADGE, MENU_ROW, MENU_ROW_INACTIVE } from "@/components/cinema/detailMenu";
import { tmdbResize } from "@/lib/images";
import { formatMinutes } from "@/lib/format";
import { useDesktopContinuity } from "@/lib/sheetMorph/desktopContinuity";
import { sheetTimeout, clearSheetTimeout } from "@/lib/sheetMorph/dom";

/**
 * Le lot H au bureau, version continuité (DECISIONS.md §61) : la maquette d'un accueil dont l'aperçu
 * suit l'affiche survolée, et une fiche qui le relaie avec le crochet de production lui-même
 * (`useDesktopContinuity`) — ce que Louis règle ici est ce qui tourne dans l'app.
 *
 * L'accueil de la maquette ne porte pas `data-sheet-home` : derrière la page des tests, le vrai
 * accueil est monté, et c'est lui que le crochet trouverait. La maquette lui passe le sien.
 */

const backdropOf = (m: CinemaMovie) => tmdbResize(m.backdropUrl, "w1280") ?? m.backdropUrl ?? "";

function Meta({ title }: { title: CinemaMovie }) {
  return (
    <div className="flex flex-wrap items-center gap-3 text-sm text-muted">
      <span>{title.year}</span>
      {title.imdbRating && <ImdbBadge rating={title.imdbRating} size="sm" />}
      {formatMinutes(title.runtimeMinutes) && <span>{formatMinutes(title.runtimeMinutes)}</span>}
    </div>
  );
}

function Row({ icon, label }: { icon: ReactNode; label: string }) {
  return (
    <button type="button" className={`${MENU_ROW} ${MENU_ROW_INACTIVE}`}>
      <span className={MENU_BADGE}>{icon}</span>
      <span className="text-sm font-medium">{label}</span>
    </button>
  );
}

function MockSheet({ title, leaving, homeRef, onClose }: { title: CinemaMovie; leaving: boolean; homeRef: RefObject<HTMLDivElement | null>; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const motion = useDesktopContinuity({ layout: "desktop", rootRef: ref, imageRef: ref, active: true, leaving, revealed: false, homeRef });
  return (
    <div ref={ref} className={`absolute inset-0 overflow-hidden bg-ink ${motion.handlesEntry ? "" : "animate-fade-in"}`} style={{ zIndex: 2 }}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img data-sheet-photo="" src={backdropOf(title)} alt="" className="absolute inset-0 h-full w-full object-cover" />
      <div data-sheet-veil="" className="absolute inset-0" style={{ background: VERTICAL_VEIL }} />
      <div data-sheet-veil="" className="absolute inset-0" style={{ background: HORIZONTAL_VEIL }} />
      <button type="button" onClick={onClose} className="btn btn-ghost absolute left-4 top-4 z-10 rounded-full bg-black/55 px-3 py-2">
        <ArrowLeft size={16} /> Retour
      </button>
      <div className="scrollbar-thin relative h-full overflow-y-auto">
        <div className={SECTION_CLASS}>
          <div data-sheet-content="" style={COLUMN_STYLE} className={`flex flex-col ${COLUMN_GAP} px-8 sm:px-16`}>
            {title.logoUrl ? (
              <CinemaLogo src={title.logoUrl} alt={title.title} surface="sheet" className="mb-1" />
            ) : (
              <h1 className="text-2xl font-bold text-white sm:text-4xl font-display">{title.title}</h1>
            )}
            <Meta title={title} />
            {title.overview && <p className="line-clamp-4 text-sm leading-relaxed text-white/90 sm:text-base">{title.overview}</p>}
            <div className="flex flex-col" style={MENU_STYLE}>
              <Row icon={<Play size={14} />} label="Lire" />
              <Row icon={<Video size={14} />} label="Bande-annonce" />
              <Row icon={<Check size={14} />} label="Vu" />
              <Row icon={<Bookmark size={14} />} label="À voir" />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export function ContinuityStage({ titles, onExit }: { titles: CinemaMovie[]; onExit: () => void }) {
  const homeRef = useRef<HTMLDivElement>(null);
  const [heroIndex, setHeroIndex] = useState(0);
  const [open, setOpen] = useState<{ title: CinemaMovie; id: number } | null>(null);
  const [leaving, setLeaving] = useState(false);
  const nextId = useRef(1);
  const hero = titles[heroIndex] ?? titles[0];

  // La fermeture rend la place aussitôt — c'est la copie du crochet qui finit de sortir —, comme la
  // vraie fiche rend l'adresse : la fiche se démonte au tour suivant, et l'accueil répond déjà.
  useEffect(() => {
    if (!leaving) return;
    const id = sheetTimeout(() => {
      setOpen(null);
      setLeaving(false);
    }, 0);
    return () => clearSheetTimeout(id);
  }, [leaving]);

  // Échap ferme la fiche, ou quitte la maquette — jamais les deux, et jamais la page des tests.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      if (open && !leaving) setLeaving(true);
      else if (!open) onExit();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, leaving, onExit]);

  const openTitle = (m: CinemaMovie) => {
    setLeaving(false);
    setOpen({ title: m, id: nextId.current++ });
  };

  const rows = [
    { name: "Récemment ajoutés", items: titles },
    { name: "Ma liste", items: [...titles].reverse() },
  ];

  return (
    <div role="dialog" aria-modal="true" className="fixed inset-0 overflow-hidden bg-ink" style={{ zIndex: 90 }}>
      <div ref={homeRef} className="absolute inset-0 flex flex-col" style={{ zIndex: 1 }}>
        {hero && (
          <>
            {/* Le fond de l'accueil, comme celui du bureau : il suit l'affiche survolée. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img key={hero.radarrId} src={backdropOf(hero)} alt="" className="absolute inset-0 h-full w-full animate-fade-in object-cover object-top" />
            <div className="absolute inset-0 bg-linear-to-r from-ink/85 via-ink/35 to-transparent" />
            <div className="absolute inset-x-0 bottom-0 h-1/2 bg-linear-to-b from-transparent to-ink" />
            <div data-sheet-hero="" className="relative flex shrink-0 grow-0 flex-col justify-end gap-3 px-8 pb-8 sm:px-12" style={{ flexBasis: "52%" }}>
              {hero.logoUrl ? (
                <CinemaLogo key={hero.radarrId} src={hero.logoUrl} alt={hero.title} surface="hero" />
              ) : (
                <h1 className="text-3xl font-bold text-white sm:text-5xl font-display">{hero.title}</h1>
              )}
              <Meta title={hero} />
              {hero.overview && <p className="line-clamp-2 max-w-xl text-sm text-white">{hero.overview}</p>}
            </div>
          </>
        )}
        <div data-sheet-rows="" className="scrollbar-thin relative min-h-0 flex-1 overflow-y-auto pb-10">
          {rows.map((row, r) => (
            <section key={row.name} className="px-8 pt-3 sm:px-12">
              <h2 className="text-lg font-semibold text-white font-display">{row.name}</h2>
              <div className="scrollbar-none -mx-3 flex gap-3 overflow-x-auto px-3 py-3">
                {row.items.map((m, i) => (
                  <button
                    key={`${r}-${m.radarrId}`}
                    type="button"
                    onMouseEnter={() => setHeroIndex(titles.indexOf(m))}
                    onFocus={() => setHeroIndex(titles.indexOf(m))}
                    onClick={() => openTitle(m)}
                    aria-label={m.title}
                    className="w-28 shrink-0 overflow-hidden rounded-lg shadow-lg shadow-black/40 transition-transform duration-200 hover:scale-105 lg:w-32"
                    data-index={i}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={m.posterUrl ?? ""} alt="" className="block aspect-[2/3] w-full object-cover" />
                  </button>
                ))}
              </div>
            </section>
          ))}
        </div>
      </div>
      {open && <MockSheet key={open.id} title={open.title} leaving={leaving} homeRef={homeRef} onClose={() => setLeaving(true)} />}
      <button type="button" onClick={onExit} className="nav-glass fixed right-4 top-4 inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-xs text-white" style={{ zIndex: 3 }}>
        <X size={14} /> Quitter la maquette
      </button>
      <p className="pointer-events-none fixed bottom-3 left-4 rounded bg-black/60 px-2 py-1 text-[11px] text-white/70" style={{ zIndex: 3 }}>
        Bureau · continuité du fond (moteur de production)
      </p>
    </div>
  );
}
