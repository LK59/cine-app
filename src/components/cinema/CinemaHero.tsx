"use client";

import { formatMinutes } from "@/lib/format";
import { HeroContinueProgress } from "@/components/cinema/HeroContinueProgress";
import { ChevronLeft, ChevronRight, Info, Play } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ImdbBadge } from "@/components/ImdbBadge";
import { QualityBadges } from "@/components/cinema/QualityBadges";
import { useT } from "@/components/TranslationProvider";
import { genreLabel } from "@/lib/top10Label";
import type { CinemaMovie } from "@/app/api/cinema/movies/route";
import { CinemaLogo } from "@/components/cinema/CinemaLogo";
import { sentencesThatFit } from "@/lib/heroSynopsis";
import { useHeroInfo } from "@/lib/useHeroInfo";

/**
 * Le synopsis d'une bannière — film ou série, écrit une fois.
 *
 * Rien plutôt que de l'anglais. Le synopsis traduit vient de TMDB et met un instant à arriver ;
 * celui qui sert de repli vient de Radarr ou de Sonarr, qui ne traduisent pas — alors sous une
 * interface en français, l'accueil affichait un texte en anglais le temps que le bon arrive, puis
 * le remplaçait. Une ligne vide un court instant se remarque moins qu'une langue qui change sous
 * les yeux. Le repli ne sert qu'une fois la réponse arrivée *sans* texte traduit.
 *
 * La bannière des films avait appris tout cela ; celle des séries, sa copie, non — elle montrait
 * l'anglais de Sonarr puis sautait au français, et sans hauteur réservée toute la bannière
 * sautait avec. Relevé le 21/09/2026 : d'où ce composant, pour que les deux ne puissent plus
 * diverger.
 */
export function HeroOverview({
  info,
  fallback,
}: {
  /** La réponse de la route `info` — `undefined` tant qu'elle n'est pas arrivée. */
  info: { tmdb: { overview: string } | null } | undefined;
  fallback: string | null | undefined;
}) {
  const text = info ? info.tmdb?.overview || fallback || "" : "";

  /**
   * Les phrases entières qui tiennent dans les deux lignes — voir `sentencesThatFit`.
   *
   * La place se mesure à l'écran, pas en caractères : elle dépend de la largeur de la fenêtre et
   * de la police. Une sonde invisible, de la largeur du paragraphe et de sa police, reçoit chaque
   * candidat ; ce qui dépasse deux lignes ne tient pas. `null` : même la première phrase déborde,
   * et le texte entier s'affiche avec un fondu en bout de seconde ligne (`clamp-fade-end-2`).
   */
  const boxRef = useRef<HTMLParagraphElement>(null);
  const probeRef = useRef<HTMLSpanElement>(null);
  const [fitted, setFitted] = useState<{ source: string; shown: string | null } | null>(null);
  const measure = useCallback(() => {
    const box = boxRef.current;
    const probe = probeRef.current;
    if (!box || !probe) return;
    const lineHeight = parseFloat(getComputedStyle(box).lineHeight);
    // Rien de mesurable (pas encore en page) : le texte entier, sans rien trancher.
    if (!Number.isFinite(lineHeight) || lineHeight <= 0 || box.clientWidth === 0) {
      setFitted({ source: text, shown: text });
      return;
    }
    const fits = (candidate: string) => {
      probe.textContent = candidate;
      return probe.offsetHeight <= lineHeight * 2 + 1;
    };
    const shown = sentencesThatFit(text, fits);
    probe.textContent = "";
    setFitted({ source: text, shown });
  }, [text]);
  // Avant le premier dessin : le texte arrive déjà arrêté sur sa phrase, jamais entier puis coupé.
  useLayoutEffect(measure, [measure]);
  // Et de nouveau quand la largeur change : deux lignes ne contiennent plus les mêmes phrases.
  useEffect(() => {
    const box = boxRef.current;
    if (!box || typeof ResizeObserver === "undefined") return;
    let width = box.clientWidth;
    const observer = new ResizeObserver(() => {
      if (box.clientWidth === width) return;
      width = box.clientWidth;
      measure();
    });
    observer.observe(box);
    return () => observer.disconnect();
  }, [measure]);

  const known = fitted?.source === text ? fitted : null;
  const overflowing = known !== null && known.shown === null;
  const shown = known?.shown ?? text;

  return (
    <p
      ref={boxRef}
      data-hero-overview
      /* Deux lignes au plus, et leur hauteur réservée : c'est ce qui empêche la mise en page de
         sauter quand le survol change de titre. Arrêté sur une phrase entière, le texte n'a
         besoin d'aucune marque ; le fondu n'est qu'un repli, vers la droite et jamais vers le bas
         — l'ancien fondu vertical se lisait comme une ombre sous le texte (23/09/2026). */
      className={`relative min-h-[2lh] max-w-xl text-sm text-white drop-shadow-sm sm:text-base ${
        overflowing ? "clamp-fade-end-2" : "max-h-[2lh] overflow-hidden"
      }`}
    >
      {/* Le texte fond dans la place qu'on lui gardait, au lieu d'y surgir ; un autre titre, un
          autre nœud, et le fondu repart (23/09/2026). */}
      <HeroText text={overflowing ? text : shown} />
      <span ref={probeRef} aria-hidden data-hero-probe className="pointer-events-none invisible absolute inset-x-0 top-0" />
    </p>
  );
}

/**
 * La ligne de distribution des deux bannières du bureau — hauteur réservée.
 *
 * Elle n'existait qu'une fois la réponse `info` arrivée, dans une colonne calée en bas : à chaque
 * changement de titre elle disparaissait, puis revenait deux cents millisecondes plus tard, et le
 * titre, les métadonnées et le synopsis descendaient d'une ligne avant de remonter (relevé le
 * 23/09/2026). La ligne reste donc toujours là, vide tant qu'il n'y a rien à dire. Partagée par
 * les films et les séries, comme `HeroOverview`, pour la même raison.
 */
/** Un texte de bannière qui fond à son arrivée — voir `HeroOverview` et `HeroCastLine`. */
function HeroText({ text }: { text: string }) {
  if (!text) return null;
  return (
    <span key={text} className="animate-fade-in">
      {text}
    </span>
  );
}

export function HeroCastLine({ info }: { info: { tmdb: { cast?: { name: string }[] } | null } | undefined }) {
  const cast = info?.tmdb?.cast ?? [];
  return (
    <p className="min-h-[1lh] max-w-xl truncate text-xs text-muted">
      <HeroText text={cast.slice(0, 5).map((c) => c.name).join(", ")} />
    </p>
  );
}

/** Ce que la bannière des reprises propose de lancer — voir `HeroBannerControls`. */
export type HeroContinueAction = { label: string; caption: string | null; progress: number | null; onPlay: () => void };

/**
 * Le logo de la bannière ouvre la fiche (08/10/2026) — la bannière reste un aperçu, mais son titre
 * mène quelque part, comme l'affiche de la bannière du téléphone. Sans `onOpen`, rien ne change.
 */
export function HeroTitleLink({ onOpen, title, children }: { onOpen?: () => void; title: string; children: React.ReactNode }) {
  if (!onOpen) return <>{children}</>;
  return (
    <button type="button" onClick={onOpen} aria-label={title} className="self-start rounded-lg text-left transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500">
      {children}
    </button>
  );
}

/**
 * Les commandes de la bannière des nouveautés au bureau (08/10/2026, DECISIONS.md §52) : « Lire » et
 * « Plus d'infos », puis `‹ ——— ›` pour la faire tourner à la main. La rangée d'affiches qui la
 * pilotait a disparu : la bannière se pilote elle-même, à la souris et aux flèches — ← → changent de
 * titre, ↓ redescend dans les rangées, ↑ remonte à la bascule Films / Séries. Rien de tout cela sur
 * l'aperçu d'une affiche survolée : on y va pour lire, et un clic sur l'affiche ouvre sa fiche.
 *
 * `data-tv-escape-up="hero"` : la flèche du haut, depuis la première rangée, arrive ici avant la
 * bascule (`useTvGridNav`).
 */
export function HeroBannerControls({
  action,
  onPlay,
  onInfo,
  count,
  index,
  running,
  runKey,
  onPick,
}: {
  /** Une reprise (bannière des reprises) : son bouton court et ce qu'il reste ; sinon « Lire ». */
  action?: HeroContinueAction | null;
  onPlay: () => void;
  onInfo: () => void;
  count: number;
  index: number;
  /** La rotation compte : le trait actif se remplit au rythme du minuteur. */
  running: boolean;
  /** Change à chaque nouveau départ du minuteur, pour rejouer le remplissage depuis zéro. */
  runKey: string;
  onPick: (index: number) => void;
}) {
  const t = useT();
  const playRef = useRef<HTMLButtonElement>(null);
  const infoRef = useRef<HTMLButtonElement>(null);
  const step = (delta: number) => onPick((index + delta + count) % count);
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
      e.stopPropagation();
      // D'un bouton à l'autre d'abord, la rotation depuis les bords (08/10/2026) : ← → faisaient
      // toujours tourner la bannière, si bien qu'aux seules flèches — une télécommande — « Plus
      // d'infos » n'était jamais atteignable. → sur « Lire » passe à « Plus d'infos », → encore
      // fait tourner ; ← sur « Plus d'infos » revient à « Lire », ← encore tourne à rebours.
      const forward = e.key === "ArrowRight";
      if (forward && e.target === playRef.current) infoRef.current?.focus();
      else if (!forward && e.target === infoRef.current) playRef.current?.focus();
      else if (count > 1) step(forward ? 1 : -1);
    } else if (e.key === "ArrowDown") {
      // Vers la première affiche de l'onglet affiché.
      const card = [...document.querySelectorAll<HTMLElement>("[data-tv-card]")].find((el) => el.offsetParent !== null);
      if (card) {
        e.preventDefault();
        e.stopPropagation();
        card.focus({ preventScroll: true });
        card.closest<HTMLElement>("[data-tv-rowroot]")?.scrollIntoView({ block: "start" });
      }
    } else if (e.key === "ArrowUp") {
      const toggle = document.querySelector<HTMLElement>('[data-tv-escape-up]:not([data-tv-escape-up="hero"])');
      if (toggle) {
        e.preventDefault();
        e.stopPropagation();
        toggle.focus();
      }
    }
  };
  const ring = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 focus-visible:ring-offset-2 focus-visible:ring-offset-black/40";
  return (
    <div className="flex flex-col items-start gap-4" onKeyDown={onKeyDown}>
      <div className="flex items-center gap-3">
        <button
          ref={playRef}
          type="button"
          data-tv-escape-up="hero"
          onClick={action ? action.onPlay : onPlay}
          className={`inline-flex items-center gap-2 rounded-full bg-white px-5 py-2.5 text-sm font-semibold text-ink shadow-lg transition-transform hover:scale-[1.03] active:scale-[0.97] ${ring}`}
        >
          <Play size={16} fill="currentColor" aria-hidden />
          {action ? action.label : t("common.play")}
        </button>
        <button
          ref={infoRef}
          type="button"
          onClick={onInfo}
          className={`nav-glass inline-flex items-center gap-2 rounded-full px-5 py-2.5 text-sm font-medium text-white transition-transform hover:scale-[1.03] active:scale-[0.97] ${ring}`}
        >
          <Info size={16} aria-hidden />
          {t("cinema.moreInfo")}
        </button>
        {action && <HeroContinueProgress caption={action.caption} progress={action.progress} />}
      </div>
      {count > 1 && (
        <div className="flex items-center gap-2">
          <button type="button" tabIndex={-1} onClick={() => step(-1)} aria-label={t("common.previous")} className="flex h-7 w-7 items-center justify-center rounded-full text-muted transition-colors hover:bg-white/10 hover:text-white">
            <ChevronLeft size={16} />
          </button>
          <div className="flex gap-1">
            {Array.from({ length: count }, (_, i) => (
              <button
                key={i}
                type="button"
                tabIndex={-1}
                onClick={() => onPick(i)}
                aria-label={String(i + 1)}
                aria-current={i === index}
                className="h-1 w-6 overflow-hidden rounded-full bg-white/25"
              >
                {i < index && <span className="block h-full w-full bg-white" />}
                {i === index && <span key={runKey} className="block h-full animate-hero-fill bg-white" style={{ animationPlayState: running ? "running" : "paused" }} />}
              </button>
            ))}
          </div>
          <button type="button" tabIndex={-1} onClick={() => step(1)} aria-label={t("common.next")} className="flex h-7 w-7 items-center justify-center rounded-full text-muted transition-colors hover:bg-white/10 hover:text-white">
            <ChevronRight size={16} />
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * « ‹ À la une » : l'aperçu d'une affiche survolée a pris la place de la bannière des nouveautés,
 * et on y revient d'un clic (08/10/2026). Atteinte par la flèche du haut depuis la première rangée,
 * elle les ramène aussi, et rend le focus à « Lire ».
 */
export function HeroBackToSpotlight({ onBack }: { onBack: () => void }) {
  const t = useT();
  return (
    <button
      type="button"
      data-tv-escape-up="hero"
      onClick={onBack}
      // Arrivée au clavier (↑ depuis la première rangée) : les nouveautés reviennent aussitôt, et le
      // focus passe sur « Lire » — un seul geste pour entrer dans la bannière.
      onFocus={onBack}
      className="nav-glass inline-flex items-center gap-1.5 self-start rounded-full py-1.5 pl-2.5 pr-3.5 text-xs font-medium text-white transition-transform hover:scale-[1.03] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500"
    >
      <ChevronLeft size={14} aria-hidden />
      {t("cinema.spotlight")}
    </button>
  );
}

// Text only — the backdrop image/gradients (and, once focus dwells long enough, the trailer
// video that takes over from them — see CinemaTrailerBackdrop) live in CinemaClient now, as one
// continuous full-screen background layer shared with the rows pane beneath (see its own doc
// comment for why: keeping the image scoped to just this component's box was exactly what
// produced a hard seam where the hero "ended"). On a hovered or focused card it is a passive
// preview — no buttons (Netflix TV home): opening CinemaMovieDetail (click/Enter on the card) is
// what surfaces Lecture/Bande-annonce/Vu/À voir. The spotlight banner itself carries its own
// controls since 08/10/2026 (`HeroBannerControls`), and its logo opens the sheet. Cast still fetched here (not just in the detail
// overlay) since this pane already shows it, same lazy/debounced approach so fast arrow-key
// scrubbing across a row doesn't fire a request per card it passes through.
export function CinemaHero({
  item,
  banner,
  onBack,
  onOpen,
}: {
  item: CinemaMovie;
  /** La bannière des nouveautés : ses commandes (`HeroBannerControls`). Absent sur un aperçu. */
  banner?: React.ReactNode;
  /** L'aperçu d'une affiche : revenir aux nouveautés (`HeroBackToSpotlight`). */
  onBack?: () => void;
  onOpen?: () => void;
}) {
  const t = useT();
  // Le synopsis et la distribution, par la requête légère de la bannière — voir `useHeroInfo`.
  // (La bande-annonce que la bannière remontait autrefois au fond vidéo n'a plus d'écouteur : le
  // fond vidéo a été retiré du grand écran.)
  const info = useHeroInfo("movie", item.tmdbId, item);

  // item.logoUrl now comes bulk-included in the /api/cinema/movies payload (same as
  // poster/backdrop already were) instead of a separate per-item fetch — known synchronously
  // the instant this renders, no debounce/timing dance needed at all, and CinemaClient's own
  // warm-up effect prefetches every logo image alongside the backdrops, so by the time focus
  // actually lands here the browser has usually already cached it. A failed logo falls back to
  // the written title and retries on its own (`useImageRetry`, keyed on its address).

  return (
    <div className="relative flex h-full max-w-2xl flex-col justify-end gap-3 px-8 pb-10 sm:px-12">
      {/* La clé sur le titre et ce qui le décrit, pas sur la colonne entière : posée sur la colonne,
          elle remontait aussi les commandes à chaque changement de titre, et « Lire » perdait le
          focus — au clavier, → ne marchait qu'une fois, et Entrée après un tour ne faisait rien
          (08/10/2026). `contents` : la colonne garde ses enfants directs pour son espacement. */}
      <div key={item.radarrId} className="contents">
      {onBack && <HeroBackToSpotlight onBack={onBack} />}
      <HeroTitleLink onOpen={onOpen} title={item.title}>
        {/* Le titre écrit tient la place d'un logo en échec, le temps qu'il réessaie (`useImageRetry`). */}
        {item.logoUrl ? (
          <CinemaLogo
            src={item.logoUrl}
            alt={item.title}
            surface="hero"
            fallback={<h1 className="text-3xl font-bold leading-tight text-white drop-shadow-lg sm:text-5xl font-display">{item.title}</h1>}
          />
        ) : (
          <h1 className="text-3xl font-bold leading-tight text-white drop-shadow-lg sm:text-5xl font-display">{item.title}</h1>
        )}
      </HeroTitleLink>

      <div className="flex flex-wrap items-center gap-3 text-sm text-muted">
        <span>{item.year}</span>
        {item.imdbRating && <ImdbBadge rating={item.imdbRating} size="sm" />}
        {/* La durée au survol, et non seulement dans la fiche : c'est elle qui décide si on lance
            le film ce soir, donc elle a sa place avant qu'on ouvre quoi que ce soit. */}
        {"runtimeMinutes" in item && formatMinutes(item.runtimeMinutes) && (
          <span>{formatMinutes(item.runtimeMinutes)}</span>
        )}
        <QualityBadges quality={item.quality} />
        {item.genres.length > 0 && <span>{item.genres.slice(0, 3).map((g) => genreLabel(g, t)).join(" · ")}</span>}
      </div>

      <HeroOverview info={info} fallback={item.overview} />
      </div>

      {/* La distribution cède sa ligne aux commandes : elle reste dans la fiche, et la bannière n'a
          pas la hauteur des deux. */}
      {banner ?? <HeroCastLine key={`cast-${item.radarrId}`} info={info} />}
    </div>
  );
}
