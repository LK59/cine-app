"use client";

import { useEffect, useLayoutEffect, useState } from "react";
import dynamic from "next/dynamic";
import { useIsMobile } from "@/lib/useIsMobile";
import { cinemaClose, cinemaNavigate, useCinemaRoute, useSheetBehind, useRouteBehind, personBehind } from "@/lib/cinemaRoute";
import { SHEET_OUT_MS } from "@/lib/sheetMotion";
import { preload } from "swr";
import { fetcher } from "@/lib/swr";
import { useExitDelay } from "@/lib/useExitDelay";
import { PlayerRail } from "./PlayerRail";
import { PlayerBottomBar } from "./PlayerBottomBar";

// Chaque panneau est un écran entier qu'on n'ouvre pas forcément de la soirée : les charger à la
// demande garde le premier rendu du lecteur à ce qu'il doit être — des affiches.
const PlayerListPanel = dynamic(() => import("./PlayerListPanel").then((m) => m.PlayerListPanel), { ssr: false });
const PlayerAccountPanel = dynamic(() => import("./PlayerAccountPanel").then((m) => m.PlayerAccountPanel), { ssr: false });
const PlayerSearchPanel = dynamic(() => import("./PlayerSearchPanel").then((m) => m.PlayerSearchPanel), { ssr: false });
const PlayerDiscoverSheet = dynamic(() => import("./PlayerDiscoverSheet").then((m) => m.PlayerDiscoverSheet), { ssr: false });
const PlayerPersonSheet = dynamic(() => import("./PlayerPersonSheet").then((m) => m.PlayerPersonSheet), { ssr: false });
// L'écran d'accueil — chargé à part : la plupart des lancements ne l'affichent pas.
const PlayerOnboardingGate = dynamic(() => import("./PlayerOnboarding").then((m) => m.PlayerOnboardingGate), { ssr: false });

/**
 * La largeur que le rail replié occupe, réservée par le contenu.
 *
 * La même valeur que `.player-rail` dans globals.css : si l'une change, l'autre aussi.
 */
const RAIL_WIDTH = "4rem";

/** La hauteur que la barre du téléphone occupe, réservée par le bas des panneaux. */
const BAR_SPACE = "5.5rem";

/** La durée des animations de sortie — celle de `--animate-fade-out`, à la milliseconde près. */
const EXIT_MS = 200;

/**
 * Retient la dernière valeur non nulle : un écran qui sort garde ce qu'il montrait.
 *
 * En état et non en référence — une référence ne se lit pas pendant un rendu, et c'est bien
 * pendant le rendu qu'on en a besoin. L'ajustement en cours de rendu est la forme que React
 * recommande pour dériver un état d'une entrée.
 */
function useLastValue(value: number | null): number | null {
  const [last, setLast] = useState(value);
  if (value !== null && value !== last) setLast(value);
  return value ?? last;
}

/**
 * La coquille du lecteur : la navigation, et les écrans qu'elle ouvre.
 *
 * L'écran cinéma lui-même n'est pas ici — il est rendu par la page, et se porte dans
 * document.body. Cette séparation est volontaire : la coquille doit pouvoir changer sans toucher
 * aux neuf cents lignes de la grille, et la grille doit pouvoir s'ouvrir sans coquille (c'est ce
 * qui se passait avant ce chantier).
 */
/**
 * `useLayoutEffect` côté navigateur, `useEffect` au rendu serveur — où il n'y a pas de mise en
 * page à mesurer, et où React avertit qu'on lui en demande une.
 */
const useIsomorphicLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

export function PlayerShell() {
  const isMobile = useIsMobile();
  const route = useCinemaRoute();

  // La variable vit sur l'élément racine parce que c'est le seul ancêtre commun entre le rail et
  // un écran porté dans document.body. Elle est remise à zéro sur téléphone, où la navigation est
  // un tiroir et ne réserve rien.
  //
  // Avant la peinture, et non après : posée dans un effet ordinaire, la grille s'affichait une
  // image entière collée au bord gauche avant de sauter de soixante-douze pixels.
  useIsomorphicLayoutEffect(() => {
    const root = document.documentElement;
    root.style.setProperty("--player-rail", isMobile ? "0px" : RAIL_WIDTH);
    // Et symétriquement en bas : la barre du téléphone flotte au-dessus du contenu, donc les
    // panneaux doivent lui réserver la place. Nulle sur grand écran, où c'est le rail qui navigue
    // et où rien ne flotte en bas.
    root.style.setProperty("--player-bar-space", isMobile ? BAR_SPACE : "0px");
    return () => {
      root.style.removeProperty("--player-rail");
      root.style.removeProperty("--player-bar-space");
    };
  }, [isMobile]);

  const search = useExitDelay(route.search, EXIT_MS);
  const list = useExitDelay(route.list, EXIT_MS);
  const account = useExitDelay(route.account, EXIT_MS);
  /**
   * Ces fiches sortent en glissant, sauf quand ce qu'elles recouvrent n'est pas dessiné.
   *
   * La règle d'avant supprimait leur sortie dès que quelque chose attendait derrière, parce que
   * l'animation découvrait alors l'accueil avant que la précédente n'entre par-dessus. Ce n'est
   * plus vrai d'une fiche de bibliothèque : la pile reste montée sous elles (voir
   * CinemaMobileClient), donc leur sortie découvre exactement ce qu'il faut, et la supprimer ne
   * faisait plus qu'une chose — ouvrir un titre de saga absent de la bibliothèque se refermait
   * d'un coup sec là où le titre d'à côté, lui, glissait.
   *
   * Le cas d'origine subsiste et garde son remède : une fiche TMDB par-dessus une *autre* fiche
   * TMDB. `useRouteBehind` ne rend un objet que pour une fiche de bibliothèque — c'est ce qui les
   * distingue.
   */
  const behind = useRouteBehind();
  // « Une fiche de bibliothèque derrière », et non « quelque chose derrière » : `useRouteBehind`
  // nomme aussi les fiches personne recouvertes depuis qu'elles appartiennent à la pile.
  const behindIsLibrarySheet = behind !== null && (behind.film !== null || behind.serie !== null);
  /**
   * La fiche personne que le titre ouvert recouvre, redessinée dessous.
   *
   * Sur téléphone seulement, et pour deux raisons qui vont ensemble : c'est là que la sortie est
   * un glissement, donc que le dessous se voit ; et c'est là qu'il y a la place, la pile mobile
   * ayant déjà ses deux crans (47 dessous, 48 dessus) là où la version bureau n'en a qu'un. Sur
   * grand écran la sortie est un fondu que `useSheetBehind` réduit déjà à zéro : rien à découvrir,
   * donc rien à dessiner.
   */
  const covering = route.film !== null || route.serie !== null || route.discover !== null;
  const personUnder = isMobile && covering && route.person === null ? personBehind(behind) : null;
  const sheetExitMs =
    useSheetBehind() && !behindIsLibrarySheet ? 0 : isMobile ? SHEET_OUT_MS : EXIT_MS;
  const person = useExitDelay(route.person !== null, sheetExitMs);
  const discover = useExitDelay(route.discover !== null, sheetExitMs);

  // L'identifiant survit à sa disparition de l'adresse, le temps que la fiche finisse de sortir :
  // sans lui, elle se viderait de son contenu avant de s'en aller.
  const lastPerson = useLastValue(route.person);
  /**
   * Qui est la fiche personne, et à quel étage.
   *
   * `personTop` quand elle est l'écran du dessus, `personUnder` quand un film la recouvre — et
   * `personId` les réunit, parce que c'est le même acteur et que ce doit être le même nœud.
   */
  const personTop = person.render && lastPerson !== null ? lastPerson : null;
  const personId = personTop ?? personUnder;
  const lastDiscover = useLastValue(route.discover);
  // Le type suit l'identifiant : sans lui, une fiche de série en train de sortir repassait sur
  // « film » — l'adresse ayant repris sa valeur par défaut — et allait rechercher le mauvais
  // titre pendant son animation.
  const [lastDiscoverType, setLastDiscoverType] = useState(route.discoverType);
  if (route.discover !== null && route.discoverType !== lastDiscoverType) setLastDiscoverType(route.discoverType);

  // Les trois panneaux arrivent en chargement différé (voir plus haut) : la toute première
  // ouverture payait donc un aller-retour réseau, ce qui, sur données mobiles, se sent comme un
  // écran qui met du temps à répondre. On va les chercher dès que le fil d'exécution est libre —
  // après l'affichage des affiches, jamais pendant.
  useEffect(() => {
    type Preloadable = { preload?: () => void };
    const warm = () => {
      // Les trois de la navigation d'abord : ce sont ceux qu'on ouvre, et souvent.
      (PlayerSearchPanel as Preloadable).preload?.();
      (PlayerListPanel as Preloadable).preload?.();
      (PlayerAccountPanel as Preloadable).preload?.();
      // Puis les deux fiches, qui s'ouvrent depuis un résultat de recherche : leur première
      // ouverture payait le même aller-retour, juste plus tard dans le parcours.
      (PlayerDiscoverSheet as Preloadable).preload?.();
      (PlayerPersonSheet as Preloadable).preload?.();
      // Et la charge utile de « Ma liste », pour que l'écran arrive rempli plutôt que vide puis
      // rempli. Elle est petite, et c'est la seule des quatre destinations qui attend une réponse
      // avant d'avoir quoi que ce soit à montrer.
      void preload("/api/player/lists", fetcher);
    };
    const idle = (window as Window & { requestIdleCallback?: (cb: () => void) => number }).requestIdleCallback;
    if (idle) {
      idle(warm);
      return;
    }
    // Safari n'a pas `requestIdleCallback` — un délai suffit à laisser passer le premier rendu.
    const timer = setTimeout(warm, 1500);
    return () => clearTimeout(timer);
  }, []);

  return (
    <>
      {/* Le rail sur grand écran, la barre du bas sur téléphone : la même navigation, dite dans
          la grammaire de chaque appareil. Le tiroir et son hamburger ont disparu — deux coins du
          haut hors de portée du pouce, et un écran entier recouvert pour poser une deuxième
          question. */}
      {isMobile ? <PlayerBottomBar /> : <PlayerRail />}
      <PlayerOnboardingGate />
      {/* Montés le temps de leur sortie : l'adresse change avant eux — un retour du navigateur
          suffit — et sans ce sursis ils disparaissaient d'un coup, alors qu'ils arrivent en
          glissant. Voir useExitDelay. */}
      {search.render && <PlayerSearchPanel leaving={search.leaving} />}
      {list.render && <PlayerListPanel leaving={list.leaving} />}
      {account.render && <PlayerAccountPanel leaving={account.leaving} />}
      {/* Une seule fiche du dessus à la fois. Deux rendues ensemble se recouvraient dans l'ordre
          de montage, et surtout écoutaient Échap toutes les deux — une touche remontait alors de
          deux crans. L'historique garde la précédente, et le retour la rouvre.

          La fiche personne fait exception, et d'une seule façon : elle peut aussi être le *fond*
          de la pile, sous un film ouvert depuis sa filmographie. C'est le même nœud, pas un
          second — voir juste en dessous. */}
      {/* Une seule et même instance, qu'elle soit dessus ou dessous.
          Elle occupait deux emplacements du JSX — celui du dessus et celui du fond de la pile —,
          donc ouvrir un film depuis une filmographie la démontait pour en monter une autre, avec
          la même identité et le même contenu, à l'instant précis où la fiche du film se monte
          elle aussi. Sur un téléphone, ça se sent. Un seul emplacement et une clé stable : React
          garde le nœud, seul `underneath` change, et le défilement de la filmographie est même
          retrouvé tel quel en refermant le film. */}
      {personId !== null && (
        <PlayerPersonSheet
          /* Un autre acteur est une autre fiche — même raison que le `key` du lecteur sur son
             film : `arrivedByBack` n'est lu qu'au montage, le défilement et le focus sont ceux de
             la fiche précédente, et une fermeture lancée juste avant l'échange continuerait de
             courir sur la suivante. */
          key={personId}
          tmdbId={personId}
          leaving={personTop !== null && person.leaving}
          underneath={personTop === null}
        />
      )}
      {/* Une fiche découverte se rend quand aucune fiche personne ne la recouvre — mais elle se
          rend *avec* celle qu'elle recouvre, s'il y en a une : c'est la même pile, à l'étage du
          dessous. Sans ce « et », l'acteur dont on vient prenait sa place au lieu de se ranger
          dessous, et un film pas encore là ouvert depuis une filmographie n'affichait rien. */}
      {personTop === null && discover.render && lastDiscover !== null && (
        <PlayerDiscoverSheet
          key={`${lastDiscoverType}:${lastDiscover}`}
          tmdbId={lastDiscover}
          mediaType={lastDiscoverType}
          leaving={discover.leaving}
        />
      )}
    </>
  );
}
