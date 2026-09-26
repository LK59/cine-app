"use client";

import { departmentLabel } from "@/lib/personDepartment";
import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import useSWR from "swr";
import { Calendar, ChevronLeft, ChevronRight, Globe, MapPin, Star, User, X } from "lucide-react";
import { InstagramIcon } from "@/components/BrandIcons";
import type { EnrichedPersonData } from "@/app/api/tmdb/person/[id]/enriched/route";
import { selectBio } from "@/lib/format";
import { getDateLocale } from "@/lib/i18n";
import { fetcher } from "@/lib/swr";
import { cinemaClose, cinemaNavigate, openLibraryTitle, arrivedByBack } from "@/lib/cinemaRoute";
import { useT, useLocale } from "@/components/TranslationProvider";
import { PlayerResultCard } from "./PlayerResultCard";
import type { PersonPhoto } from "@/app/api/tmdb/person/[id]/photos/route";
import { useIsMobile, useIsShortViewport } from "@/lib/useIsMobile";
import { useSwipeToDismiss } from "@/lib/useSwipeToDismiss";
import { SHEET_OUT_MS, sheetMotionClass } from "@/lib/sheetMotion";
import { useSheetExit } from "@/lib/useSheetExit";

const LINK_CHIP =
  "flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-2.5 py-1.5 text-xs font-medium text-muted transition-colors hover:bg-white/10 hover:text-white";

interface PersonCredit {
  tmdbId: number;
  title: string;
  year: number | null;
  posterPath: string | null;
  mediaType: "movie" | "tv";
  character: string;
  voteAverage: number;
  inLibrary: boolean;
  libraryId: number | null;
}

interface PersonPayload {
  credits: PersonCredit[];
  name: string | null;
  profilePath: string | null;
  biography: string | null;
  birthday: string | null;
  deathday: string | null;
  placeOfBirth: string | null;
  knownFor: string | null;
}

const TMDB_PROFILE = "https://image.tmdb.org/t/p/w300";

function formatDate(iso: string, dateLocale: string): string {
  return new Date(iso).toLocaleDateString(dateLocale, { day: "numeric", month: "long", year: "numeric" });
}

/** L'âge, ou l'âge au décès. Calculé sur la date de fin plutôt que sur « maintenant » quand il y en a une. */
function ageAt(birthday: string, deathday: string | null, now: number): number | null {
  const born = new Date(birthday).getTime();
  const end = deathday ? new Date(deathday).getTime() : now;
  if (!Number.isFinite(born) || !Number.isFinite(end)) return null;
  return Math.floor((end - born) / (365.25 * 24 * 3600 * 1000));
}

/**
 * Les photos de la personne, en une rangée qu'on fait défiler.
 *
 * Elles existaient déjà côté gestion et n'avaient pas suivi ici. Elles arrivent d'une route à
 * part, en chargement différé : la fiche s'affiche sans les attendre, et la rangée apparaît quand
 * elles sont là — plutôt que de retarder la filmographie, qui est ce qu'on vient voir.
 */
const NO_PHOTOS: PersonPhoto[] = [];

// Mémorisée : voir `PersonFilmography`, pour la même raison.
const PhotoRow = memo(function PhotoRow({ photos, onOpen, label }: { photos: PersonPhoto[]; onOpen: (i: number) => void; label: string }) {
  if (photos.length === 0) return null;
  return (
    <div className="mt-8">
      <h2 className="mb-3 font-display text-lg font-semibold text-white">{label}</h2>
      <div className="scrollbar-thin flex gap-3 overflow-x-auto pb-2">
        {photos.map((photo, i) => (
          <button
            key={photo.filePath}
            type="button"
            onClick={() => onOpen(i)}
            className="h-44 shrink-0 overflow-hidden rounded-lg bg-white/5 ring-1 ring-white/10 transition hover:ring-white/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 sm:h-56"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={photo.filePath}
              alt=""
              loading="lazy"
              decoding="async"
              className="h-full w-auto object-cover"
              style={{ aspectRatio: photo.aspectRatio || 2 / 3 }}
            />
          </button>
        ))}
      </div>
    </div>
  );
});

/**
 * Une photo en grand.
 *
 * Portée dans document.body et au-dessus de tout le reste : c'est la seule chose à l'écran tant
 * qu'elle est ouverte. Échap et les flèches, comme partout ailleurs dans cette application.
 */
function PhotoViewer({
  photos,
  index,
  onIndex,
  onClose,
}: {
  photos: PersonPhoto[];
  index: number;
  onIndex: (i: number) => void;
  onClose: () => void;
}) {
  const prev = useCallback(() => onIndex((index - 1 + photos.length) % photos.length), [index, photos.length, onIndex]);
  const next = useCallback(() => onIndex((index + 1) % photos.length), [index, photos.length, onIndex]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!["Escape", "Backspace", "ArrowLeft", "ArrowRight"].includes(e.key)) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "ArrowLeft") prev();
      else if (e.key === "ArrowRight") next();
      else onClose();
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [prev, next, onClose]);

  if (typeof document === "undefined") return null;

  return createPortal(
    <div
      className="fixed inset-0 grid animate-fade-in place-items-center bg-black/95 p-4"
      style={{ zIndex: 60 }}
      onClick={onClose}
    >
      {photos.length > 1 && (
        <>
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); prev(); }}
            className="btn-overlay absolute left-3 top-1/2 -translate-y-1/2"
          >
            <ChevronLeft size={22} />
          </button>
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); next(); }}
            className="btn-overlay absolute right-3 top-1/2 -translate-y-1/2"
          >
            <ChevronRight size={22} />
          </button>
        </>
      )}
      <button type="button" onClick={onClose} className="btn-overlay absolute right-3 top-3">
        <X size={20} />
      </button>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={photos[index].fullPath}
        alt=""
        decoding="async"
        onClick={(e) => e.stopPropagation()}
        className="max-h-[85vh] max-w-full rounded-lg object-contain"
      />
      <span className="absolute bottom-5 rounded-full bg-white/10 px-3 py-1 text-xs text-muted">
        {index + 1} / {photos.length}
      </span>
    </div>,
    document.body
  );
}
const TMDB_POSTER = "https://image.tmdb.org/t/p/w342";

/**
 * Ce qu'on dessine à la première image, avant que le reste ne suive.
 *
 * Mesuré sur TMDB depuis cette installation : soixante-seize titres pour Ryan Gosling, **cent
 * cinquante-huit** pour Brad Pitt. Une grille de cent cinquante-huit cartes construite d'un seul
 * coup se sent sur un téléphone — c'est le micro-blocage signalé le 19/09/2026 « autour de la
 * fiche personne ». Les images, elles, sont déjà différées par le navigateur ; ce qui coûte est le
 * nombre de nœuds et le travail de React.
 *
 * Dix-huit remplissent l'écran à toutes les densités. Le reste arrive au temps mort suivant, donc
 * avant même qu'un doigt ait pu descendre jusque-là : rien n'est retiré, seulement étalé sur deux
 * images au lieu d'une.
 */
const FIRST_PAINT = 18;
/** Ce qu'on ajoute à chaque temps mort, une fois la carte posée. Voir `settled`. */
const FILL_CHUNK = 24;
/** Au cas où la fin d'animation ne serait jamais annoncée (onglet caché, mouvement réduit…). */
const SETTLE_FALLBACK_MS = 450;

/**
 * La fiche d'une personne, dans le lecteur.
 *
 * Elle existait déjà côté gestion, en neuf cents lignes ; celle-ci en garde ce qui sert à
 * quelqu'un qui cherche quoi regarder — le portrait, une biographie qu'on peut déplier, et la
 * filmographie. Ce qui change vraiment est ailleurs : chaque titre y ouvre une fiche du lecteur,
 * qu'on le possède ou non, au lieu de renvoyer vers une page d'outillage. C'est ce qui fait que
 * l'on ne sort jamais de l'interface.
 */
function openCredit(c: PersonCredit) {
  const type = c.mediaType === "movie" ? "movie" : "series";
  /* La fiche prend la place de celle-ci, et le retour y ramène — voir `openLibraryTitle`, qui
     referme ce qui la couvre ; la fiche découverte ne passe pas par elle, d'où `person: null`.
     L'onglet suit le type, sans quoi une série ouverte depuis un acteur ne se résout pas. */
  if (c.libraryId !== null) openLibraryTitle(type, c.libraryId);
  else cinemaNavigate({ discover: c.tmdbId, discoverType: type, person: null });
}

function creditCard(c: PersonCredit) {
  return (
    <PlayerResultCard
      key={`${c.mediaType}-${c.tmdbId}`}
      kind={c.mediaType === "movie" ? "movie" : "series"}
      title={c.title}
      subtitle={c.character || (c.year ? String(c.year) : null)}
      poster={c.posterPath ? `${TMDB_POSTER}${c.posterPath}` : null}
      missing={!c.inLibrary}
      onOpen={() => openCredit(c)}
    />
  );
}

/**
 * La filmographie en deux temps : ce qui se regarde ce soir, puis le reste — qui ouvre sa fiche
 * découverte, d'où l'on peut le demander.
 *
 * Mémorisée, et c'est tout son rôle (23/09/2026). Un glissement de fermeture redessine la fiche à
 * chaque mouvement du doigt — la position de la carte vit dans l'état de `useSwipeToDismiss` —, et
 * la filmographie, recréée à chaque rendu, reconstruisait ses centaines de cartes à chaque pixel :
 * la fermeture des fiches personne était saccadée, là où celles des films, plus légères, restaient
 * fluides. Ses entrées ne changent pas pendant un geste ni pendant une sortie : React la saute.
 */
const PersonFilmography = memo(function PersonFilmography({
  owned,
  elsewhere,
  inLibraryLabel,
  elsewhereLabel,
}: {
  owned: PersonCredit[];
  elsewhere: PersonCredit[];
  inLibraryLabel: string;
  elsewhereLabel: string;
}) {
  return (
    <>
      {owned.length > 0 && (
        <section className="mt-8">
          <h2 className="mb-4 font-display text-lg font-semibold text-white">{inLibraryLabel}</h2>
          <div className="player-grid grid grid-cols-3 gap-x-3 gap-y-6 sm:grid-cols-4 md:grid-cols-5">
            {owned.map(creditCard)}
          </div>
        </section>
      )}
      {elsewhere.length > 0 && (
        <section className="mt-8">
          <h2 className="mb-4 font-display text-lg font-semibold text-white">{elsewhereLabel}</h2>
          <div className="player-grid grid grid-cols-3 gap-x-3 gap-y-6 sm:grid-cols-4 md:grid-cols-5">
            {elsewhere.map(creditCard)}
          </div>
        </section>
      )}
    </>
  );
});

export function PlayerPersonSheet({
  tmdbId,
  leaving = false,
  /**
   * Cette fiche est celle du **dessous** : le film ouvert depuis sa filmographie la recouvre.
   *
   * Même rôle exactement que `underneath` sur les fiches de titre, et pour la même raison — c'est
   * ce qu'on découvre en tirant la carte du dessus vers le bas, et ce qui fait que l'empilement se
   * lit comme un empilement. Elle n'est pas « restée ouverte » : elle est redessinée à partir de
   * l'entrée d'historique que le film recouvre (voir `personBehind`), ce qui évite d'avoir à
   * décider qui, de la personne ou du titre, est au-dessus — l'adresse ne porte plus que le titre.
   *
   * Inerte, et l'inertie ne touche pas au dessin : pas d'Échap — deux écouteurs sur la même touche
   * reculeraient de deux crans —, pas de geste, pas de fermeture. Rien à couper côté pointeurs en
   * revanche, ce qui la recouvre est une fiche pleine et opaque.
   */
  underneath = false,
}: {
  tmdbId: number;
  leaving?: boolean;
  underneath?: boolean;
}) {
  const t = useT();
  const isMobile = useIsMobile();
  const short = useIsShortViewport();
  const [expanded, setExpanded] = useState(false);
  const [photoIndex, setPhotoIndex] = useState<number | null>(null);
  const { data, isLoading } = useSWR<PersonPayload>(`/api/tmdb/person/${tmdbId}`, fetcher, {
    revalidateOnFocus: false,
  });
  // Une requête à part, qui ne retarde pas la fiche : la rangée apparaît quand elle arrive.
  const { data: photoData } = useSWR<{ photos: PersonPhoto[] }>(`/api/tmdb/person/${tmdbId}/photos`, fetcher, {
    revalidateOnFocus: false,
  });
  const photos = photoData?.photos ?? NO_PHOTOS;
  // Les liens et la biographie de Wikipédia — la partie de la fiche de gestion qui manquait ici.
  // À part, et en différé comme les photos : la fiche s'affiche sans attendre Wikipédia.
  const { data: enriched } = useSWR<EnrichedPersonData>(`/api/tmdb/person/${tmdbId}/enriched`, fetcher, {
    revalidateOnFocus: false,
  });
  const { locale } = useLocale();
  const dateLocale = getDateLocale(locale);
  // Lu une fois : l'horloge n'a pas sa place dans un rendu (règle du compilateur React).
  const [now] = useState(() => Date.now());

  const close = () => cinemaClose({ person: null });
  /**
   * Un seul mécanisme de sortie, et c'est le parent qui l'a.
   *
   * Cette fiche en avait **deux**, ce que la section « The sheet lifecycle » de CLAUDE.md
   * interdit explicitement : `useDelayedClose` à l'intérieur, qui retenait l'adresse 280 ms, et
   * `useExitDelay` dans la coquille, qui la gardait montée 280 ms de plus *après* que l'adresse
   * ait changé. Les deux s'enchaînaient au lieu de se recouvrir — jusqu'à une demi-seconde de
   * fiche sortante, pendant laquelle la suivante se montait déjà. C'est ce qui rendait les
   * imbrications profondes poisseuses puis bloquées : refermer deux fois de suite laissait deux
   * écrans pleins vivants en même temps, chacun avec son geste et son écouteur de touches.
   *
   * La fermeture est donc immédiate. La coquille, qui rend cette fiche d'après l'adresse, sait
   * seule combien de temps la garder ensuite — et elle sait aussi quand ce n'est pas la peine,
   * parce qu'une autre fiche attend derrière. Voir `sheetExitMs` dans PlayerShell.
   *
   * Et une fois la sortie commencée, plus rien ne la redemande — voir `useSheetExit`. Échap y est
   * écouté, sauf tant que la visionneuse est ouverte : elle écoute Échap elle aussi, et deux
   * écouteurs posés sur la même cible se déclenchent tous les deux — une seule touche aurait fermé
   * la photo *et* la fiche derrière.
   */
  const exit = useSheetExit(close, { leaving, listening: photoIndex === null && !underneath });
  const requestClose = exit.requestClose;
  /**
   * Le même geste que sur les fiches de films : on tire la fiche vers le bas pour la refermer. La
   * poignée est le bloc du portrait et du nom — il n'y a pas de bannière ici.
   *
   * Après un glissement, la fermeture attend deux images — pas davantage. Elle partait dans le même
   * tour que le relâchement : l'accueil se redessinait (l'adresse change), la coquille et la barre
   * du bas aussi, avant même que le navigateur ait lancé le glissement de la carte, qui restait
   * figée le temps de ce travail — sur un lancer rapide, l'accrochage que les fiches de films
   * n'avaient pas (23/09/2026). Deux images suffisent à ce que la carte, déjà sur son calque, glisse
   * d'elle-même pendant ce travail.
   *
   * Pas `useDelayedClose` : ce serait un second mécanisme de sortie, que la note ci-dessus interdit
   * — rien n'est gardé monté plus longtemps, l'appel est seulement décalé.
   */
  const closeAfterSlideStarts = useCallback(() => {
    requestAnimationFrame(() => requestAnimationFrame(() => requestClose()));
  }, [requestClose]);
  const swipe = useSwipeToDismiss(closeAfterSlideStarts);
  // Montée parce qu'on revient dessus plutôt qu'on l'ouvre : pas d'animation d'entrée — voir
  // `arrivedByBack`. Lu une seule fois, au montage.
  const [revealed] = useState(() => arrivedByBack());

  // Ce qu'on possède d'abord : c'est ce qui se regarde ce soir. Le serveur trie déjà ainsi, on
  // garde son ordre et on se contente de retirer les entrées sans titre.
  const credits = useMemo(() => (data?.credits ?? []).filter((c) => c.title), [data]);
  const ownedTotal = credits.filter((c) => c.inLibrary).length;

  /**
   * La filmographie entière, une image après la première.
   *
   * `setState` dans le rappel d'un temps mort, jamais dans le corps de l'effet — voir la règle du
   * compilateur React dans CLAUDE.md. Le repli par minuteur couvre Safari, qui n'a pas
   * `requestIdleCallback`.
   *
   * La fiche du dessous, elle, n'en sort jamais : elle est recouverte par une fiche pleine, on n'en
   * voit que le haut pendant le glissement, et personne ne la fait défiler. Dix-huit cartes
   * suffisent donc à ce qu'elle a à montrer — et c'est autant de travail en moins à l'instant
   * précis où le film du dessus se monte.
   */
  /**
   * Rien de lourd tant que la carte glisse.
   *
   * Mesuré le 21/09/2026 sur un banc Playwright (téléphone 390×844, processeur bridé ×6) : poser
   * soixante cartes d'un coup fige une image pendant ~140 ms, et le temps mort d'avant tombait
   * **dans** le glissement (délai 300 ms, animation 340 ms) — l'à-coup se voyait en pleine entrée,
   * à chaque cran d'une cascade acteur → film → acteur. Le flou, lui, ne pesait presque rien.
   *
   * `settled` passe à vrai à la fin de l'animation d'entrée (ou tout de suite quand on revient sur
   * la carte par un retour, sans animation), avec un minuteur de secours si l'évènement ne vient
   * pas. Ce qui attend : la suite de la filmographie, les photos, les liens et la biographie.
   */
  const [settled, setSettled] = useState(revealed);
  useEffect(() => {
    if (settled) return;
    const timer = window.setTimeout(() => setSettled(true), SETTLE_FALLBACK_MS);
    return () => clearTimeout(timer);
  }, [settled]);

  /**
   * Puis la filmographie par paquets, un paquet par temps mort.
   *
   * Tout d'un coup après l'entrée, l'arrêt de ~140 ms ne faisait que changer de place : invisible
   * tant que la carte est immobile, bien visible si le doigt la fait défiler aussitôt. Vingt-quatre
   * cartes par tour, c'est une image courte chacune. Armé sur l'arrivée des données, et non sur le
   * montage : la filmographie vient d'une requête. `setState` dans le rappel, jamais dans le corps
   * de l'effet (règle du compilateur React) ; le minuteur couvre Safari, sans `requestIdleCallback`.
   */
  const [shown, setShown] = useState(FIRST_PAINT);
  // Et jamais pendant un geste ni une sortie (23/09/2026) : les temps morts existent aussi entre
  // deux mouvements du doigt, et un paquet de vingt-quatre cartes posé à ce moment-là se sentait
  // comme une saccade « à certains moments » du glissement. Une fiche revenue en place reprend.
  const holding = swipe.dragging || swipe.dismissed || leaving;
  useEffect(() => {
    if (holding || underneath || !data || !settled || shown >= credits.length) return;
    const grow = () => setShown((n) => n + FILL_CHUNK);
    const idle = (window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }).requestIdleCallback;
    if (idle) {
      const handle = idle(grow, { timeout: 200 });
      return () => (window as Window & { cancelIdleCallback?: (h: number) => void }).cancelIdleCallback?.(handle);
    }
    const timer = window.setTimeout(grow, 32);
    return () => clearTimeout(timer);
  }, [holding, underneath, data, settled, shown, credits.length]);

  // Mémorisées : ce sont les entrées de `PersonFilmography`, qui doivent garder leur identité
  // tant que rien ne change — un glissement, une sortie ne changent ni l'une ni l'autre.
  const owned = useMemo(() => credits.slice(0, shown).filter((c) => c.inLibrary), [credits, shown]);
  const elsewhere = useMemo(() => credits.slice(0, shown).filter((c) => !c.inLibrary), [credits, shown]);

  // Même garde que les fiches du mode cinéma : ce composant peut être rendu côté serveur, où
  // `document` n'existe pas et où `createPortal` fait échouer la page entière.
  if (typeof document === "undefined") return null;

  // Liens et biographie une fois la carte posée : arrivés en plein glissement, ils poussaient
  // tout le contenu vers le bas pendant qu'il bougeait. Avant, rien — plutôt que la biographie
  // de TMDB remplacée par celle de Wikipédia sous les yeux.
  const links = settled ? enriched : undefined;
  const bio = settled ? selectBio(data?.biography, enriched?.wikiBio) : null;
  const age = data?.birthday ? ageAt(data.birthday, data.deathday, now) : null;

  return createPortal(
    /**
     * Une carte posée sur ce qu'on regardait, et non plus une page qui le remplace.
     *
     * C'est la fiche acteur de la gestion (`ActorModal`), transposée le 21/09/2026 à la demande de
     * Louis : le film reste visible derrière un voile, on lit la personne, on la referme d'un geste
     * vers le bas et l'on est exactement où l'on était. Sur téléphone elle monte du bas, sur grand
     * écran elle se pose au centre. Tout le reste — l'adresse, la pile, `underneath`, la sortie
     * tenue par la coquille, la filmographie étalée sur deux images — n'a pas bougé : seul le
     * dessin a changé.
     */
    <div
      className={`fixed inset-0 flex justify-center ${isMobile ? "items-end" : "items-center p-6"}`}
      style={{
        // Le même couple que la pile des fiches de titre : 47 dessous, 48 dessus.
        zIndex: underneath ? 47 : 48,
        paddingLeft: isMobile ? undefined : "calc(1.5rem + var(--player-rail, 0px) + env(safe-area-inset-left, 0px))",
        // Inerte pendant sa sortie : voile, croix et poignée restent sous le doigt 280 ms. Après un
        // glissement, dès le relâchement — la fermeture part deux images plus tard.
        ...exit.style,
        ...(swipe.dismissed ? { pointerEvents: "none" as const } : {}),
      }}
    >
      {/* Le voile : il laisse voir le film qu'on regardait, et le toucher referme la carte. */}
      <div
        aria-hidden
        data-person-scrim
        onClick={underneath ? undefined : requestClose}
        // Le flou sur grand écran seulement. Un `backdrop-filter` plein écran se recalcule à chaque
        // image de ce qui bouge dessous ou dessus — et sur téléphone, dans une cascade, il y a
        // toujours quelque chose qui bouge : c'est ce qui a déjà fait saccader iOS ailleurs ici.
        className={`absolute inset-0 ${isMobile ? "bg-black/75" : "bg-black/70 backdrop-blur-sm"} ${
          // Après un geste, la sortie du voile est la suite de ce geste — voir `style`.
          leaving && !swipe.dismissed ? "animate-fade-out" : leaving || revealed ? "" : "animate-fade-in"
        }`}
        /**
         * Le voile suit le doigt, puis s'efface d'où il en est.
         *
         * Au relâchement, la carte part d'un coup « hors de l'écran » : l'opacité calculée tombait
         * à 0,2 sans transition, puis la sortie démarrait `fade-out`, qui repart de 1. Le voile
         * faisait 0,6 → 0,2 → 1 → 0 en quelques images — la micro-saccade de la fermeture au doigt
         * (23/09/2026), propre à cette fiche : c'est la seule qui a un voile. Il glisse désormais
         * vers 0, depuis sa valeur, avec la courbe de la carte.
         */
        style={{
          opacity: swipe.dismissed ? 0 : swipe.offset > 0 ? Math.max(0.2, 1 - swipe.offset / 400) : undefined,
          transition: swipe.dragging ? "none" : "opacity 280ms cubic-bezier(0.32, 0.72, 0, 1)",
        }}
      />

      <div
        role="dialog"
        aria-modal="true"
        // La fin de l'entrée, et seulement la sienne : les animations des enfants remontent jusqu'ici.
        onAnimationEnd={(e) => {
          if (e.target === e.currentTarget) setSettled(true);
        }}
        aria-label={data?.name ?? undefined}
        /**
         * Sur téléphone, la carte **est** le conteneur de défilement, et c'est elle qu'on anime :
         * un calque qui contient un défilement imbriqué ne se déplace pas proprement dans WebKit,
         * et la sortie saccadait. Même raison, même traitement que sur les fiches de titre.
         */
        className={`scrollbar-thin relative w-full overflow-y-auto overscroll-contain bg-ink shadow-2xl ring-1 ring-white/10 ${
          isMobile ? "max-h-[92dvh] rounded-t-2xl" : "max-h-[88vh] max-w-4xl rounded-2xl"
        } ${sheetMotionClass({
          swipe,
          leaving,
          revealed,
          // Par la même décision que la mise en page, et non par la largeur : un téléphone couché
          // dépasse 768 px et restait « mobile » pour tout le reste — la fiche s'y posait en bas,
          // mais apparaissait en fondu au lieu de monter comme les autres (23/09/2026).
          out: isMobile ? "sheet-out" : "animate-fade-out",
          into: isMobile ? "sheet-in" : "animate-fade-in",
        })}`}
        style={{
          transform: swipe.touched ? `translateY(${swipe.offset}px)` : undefined,
          // Pas de transition pendant que le doigt est posé : la carte *est* où il est. C'est le
          // relâchement qu'on adoucit — le retour en place comme le reste du chemin vers le bas.
          transition: swipe.dragging ? "none" : "transform 280ms cubic-bezier(0.32, 0.72, 0, 1)",
          // Le calque est préparé dès que le doigt se pose, et gardé jusqu'au bout de la sortie :
          // c'est ce qui laisse la carte glisser d'elle-même pendant que l'accueil se redessine
          // (voir `closeAfterSlideStarts`).
          willChange: swipe.dragging || swipe.dismissed ? "transform" : undefined,
          paddingBottom: "env(safe-area-inset-bottom, 0px)",
        }}
      >
        <button
          type="button"
          onClick={requestClose}
          aria-label={t("common.close")}
          className="absolute right-3 top-3 z-10 flex h-9 w-9 items-center justify-center rounded-full bg-black/50 text-white float-edge transition hover:bg-black/70 active:scale-95"
        >
          <X size={18} />
        </button>

        {/* La poignée du geste : la barre et tout l'en-tête. `touch-action: none` pour que le
            navigateur ne réclame pas ce mouvement pour son propre défilement — sinon il vole le
            flux de pointeurs au milieu du glissement. Le reste de la carte défile normalement. */}
        <div
          {...(isMobile && !underneath ? swipe.handlers : {})}
          style={isMobile ? { touchAction: "none" } : undefined}
          className="px-5 pt-3 sm:px-8 sm:pt-8"
        >
          {isMobile && <div aria-hidden className="mx-auto mb-4 h-1 w-10 rounded-full bg-white/25" />}

          {isLoading && (
            <div className="flex justify-center py-16">
              <div className="h-8 w-8 animate-spin rounded-full border-2 border-white/20 border-t-white" />
            </div>
          )}

          {data && (
            <div className="flex items-start gap-4 pr-10 sm:gap-6">
              <div
                className={`shrink-0 overflow-hidden rounded-full bg-white/5 ring-2 ring-white/10 ${
                  short ? "h-20 w-20" : "h-24 w-24 sm:h-32 sm:w-32"
                }`}
              >
                {data.profilePath ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={`${TMDB_PROFILE}${data.profilePath}`} alt="" className="h-full w-full object-cover" />
                ) : (
                  <div className="flex h-full w-full items-center justify-center text-subtle">
                    <User size={32} />
                  </div>
                )}
              </div>

              <div className="min-w-0 flex-1">
                <h1 className="font-display text-2xl font-semibold text-white sm:text-3xl">{data.name}</h1>
                {departmentLabel(t, data.knownFor) && <p className="mt-0.5 text-xs text-subtle">{departmentLabel(t, data.knownFor)}</p>}
                <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
                  {data.birthday && (
                    <span className="flex items-center gap-1.5">
                      <Calendar size={12} className="shrink-0 text-subtle" />
                      {formatDate(data.birthday, dateLocale)}
                      {age !== null && (
                        <span className="text-subtle">
                          {data.deathday
                            ? `— ${t("modals.actor.died", { date: formatDate(data.deathday, dateLocale), n: age })}`
                            : `(${t("modals.actor.age", { n: age })})`}
                        </span>
                      )}
                    </span>
                  )}
                  {data.placeOfBirth && (
                    <span className="flex items-center gap-1.5">
                      <MapPin size={12} className="shrink-0 text-subtle" />
                      {data.placeOfBirth}
                    </span>
                  )}
                </div>
                {credits.length > 0 && (
                  <p className="mt-1 text-xs text-subtle">
                    {t("modals.actor.works", { n: credits.length })} · {t("player.person.ownedCount", { owned: ownedTotal, total: credits.length })}
                  </p>
                )}
              </div>
            </div>
          )}
        </div>

        {data && (
          <div className="px-5 pb-8 sm:px-8">
            {/* Des blocs neutres, la couleur sur l'icône seule (23/09/2026) : en rose, jaune et
                bleu pleins, ces trois liens étaient les seules taches de couleur d'une fiche par
                ailleurs sobre, et tiraient l'œil avant le nom. */}
            {(links?.instagram || links?.imdb || links?.wikipedia) && (
              <div className="mt-4 flex flex-wrap gap-2">
                {links.instagram && (
                  <a href={links.instagram} target="_blank" rel="noopener noreferrer" className={LINK_CHIP}>
                    <InstagramIcon size={12} className="text-pink-400" /> Instagram
                  </a>
                )}
                {links.imdb && (
                  <a href={links.imdb} target="_blank" rel="noopener noreferrer" className={LINK_CHIP}>
                    <Star size={12} className="text-amber-400" /> IMDb
                  </a>
                )}
                {links.wikipedia && (
                  <a href={links.wikipedia} target="_blank" rel="noopener noreferrer" className={LINK_CHIP}>
                    <Globe size={12} className="text-sky-400" /> Wikipédia
                  </a>
                )}
              </div>
            )}

            {/* Pas sous une fiche pleine : c'est une rangée d'images qu'on ne verra pas, montée
                à l'instant où le film du dessus, lui, a besoin de tout le fil d'exécution. */}
            {!underneath && settled && <PhotoRow photos={photos} onOpen={setPhotoIndex} label={t("player.person.photos")} />}

            {/* La biographie de Wikipédia quand elle existe, dans la langue du compte — plus
                complète que celle de TMDB, souvent vide ou en anglais. Voir `selectBio`. */}
            {bio && (
              <div className="mt-5 rounded-xl bg-white/5 p-4">
                <p className={`select-text text-sm leading-7 text-muted ${expanded ? "" : short ? "line-clamp-3" : "line-clamp-5"}`}>
                  {bio.text}
                </p>
                <div className="mt-2 flex items-center justify-between gap-3">
                  <button
                    type="button"
                    onClick={() => setExpanded((v) => !v)}
                    className="text-xs font-medium text-muted hover:text-white"
                  >
                    {expanded ? t("player.person.less") : t("cinema.readMore")}
                  </button>
                  <span className="text-[11px] text-subtle">
                    {bio.source === "wikipedia" ? t("modals.actor.sourceWikipedia") : t("modals.actor.sourceTmdb")}
                  </span>
                </div>
              </div>
            )}

            <PersonFilmography
              owned={owned}
              elsewhere={elsewhere}
              inLibraryLabel={t("modals.actor.inLibrary")}
              elsewhereLabel={t("player.person.elsewhere")}
            />
          </div>
        )}
      </div>

      {photoIndex !== null && photos.length > 0 && (
        <PhotoViewer
          photos={photos}
          index={photoIndex}
          onIndex={setPhotoIndex}
          onClose={() => setPhotoIndex(null)}
        />
      )}
    </div>,
    document.body
  );
}
