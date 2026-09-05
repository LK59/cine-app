"use client";

import { useEffect, useLayoutEffect, useState } from "react";
import dynamic from "next/dynamic";
import { useIsMobile } from "@/lib/useIsMobile";
import { cinemaClose, cinemaNavigate, useCinemaRoute, useSheetBehind } from "@/lib/cinemaRoute";
import { useExitDelay } from "@/lib/useExitDelay";
import { PlayerRail } from "./PlayerRail";
import { PlayerDrawer } from "./PlayerDrawer";

// Chaque panneau est un écran entier qu'on n'ouvre pas forcément de la soirée : les charger à la
// demande garde le premier rendu du lecteur à ce qu'il doit être — des affiches.
const PlayerListPanel = dynamic(() => import("./PlayerListPanel").then((m) => m.PlayerListPanel), { ssr: false });
const PlayerAccountPanel = dynamic(() => import("./PlayerAccountPanel").then((m) => m.PlayerAccountPanel), { ssr: false });
const PlayerSearchPanel = dynamic(() => import("./PlayerSearchPanel").then((m) => m.PlayerSearchPanel), { ssr: false });
const PlayerDiscoverSheet = dynamic(() => import("./PlayerDiscoverSheet").then((m) => m.PlayerDiscoverSheet), { ssr: false });
const PlayerPersonSheet = dynamic(() => import("./PlayerPersonSheet").then((m) => m.PlayerPersonSheet), { ssr: false });

/** La largeur que le rail replié occupe, réservée par le contenu. Voir globals.css. */
const RAIL_WIDTH = "4.5rem";

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
    return () => {
      root.style.removeProperty("--player-rail");
    };
  }, [isMobile]);

  const search = useExitDelay(route.search, EXIT_MS);
  const list = useExitDelay(route.list, EXIT_MS);
  const account = useExitDelay(route.account, EXIT_MS);
  // Les fiches ne s'effacent pas quand une autre attend derrière : leur sortie découvrirait
  // l'accueil le temps de l'animation, avant que la précédente n'entre par-dessus. Voir
  // `useSheetBehind`.
  const sheetExitMs = useSheetBehind() ? 0 : EXIT_MS;
  const person = useExitDelay(route.person !== null, sheetExitMs);
  const discover = useExitDelay(route.discover !== null, sheetExitMs);

  // L'identifiant survit à sa disparition de l'adresse, le temps que la fiche finisse de sortir :
  // sans lui, elle se viderait de son contenu avant de s'en aller.
  const lastPerson = useLastValue(route.person);
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
      (PlayerSearchPanel as Preloadable).preload?.();
      (PlayerListPanel as Preloadable).preload?.();
      (PlayerAccountPanel as Preloadable).preload?.();
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
      {isMobile ? (
        <PlayerDrawer
          open={route.menu}
          onOpenChange={(open) => (open ? cinemaNavigate({ menu: true }) : cinemaClose({ menu: false }))}
        />
      ) : (
        <PlayerRail />
      )}
      {/* Montés le temps de leur sortie : l'adresse change avant eux — un retour du navigateur
          suffit — et sans ce sursis ils disparaissaient d'un coup, alors qu'ils arrivent en
          glissant. Voir useExitDelay. */}
      {search.render && <PlayerSearchPanel leaving={search.leaving} />}
      {list.render && <PlayerListPanel leaving={list.leaving} />}
      {account.render && <PlayerAccountPanel leaving={account.leaving} />}
      {/* Une seule fiche à la fois, la plus profonde. Elles partagent le même plan (47) : deux
          rendues ensemble se recouvraient dans l'ordre de montage, et surtout écoutaient Échap
          toutes les deux — une touche remontait alors de deux crans. L'historique garde la
          précédente, et le retour la rouvre.

          L'ordre dit la profondeur : depuis une fiche de titre on ouvre un acteur, et depuis un
          acteur une autre fiche de titre. La personne est donc toujours au-dessus. */}
      {person.render && lastPerson !== null ? (
        <PlayerPersonSheet tmdbId={lastPerson} leaving={person.leaving} />
      ) : discover.render && lastDiscover !== null ? (
        <PlayerDiscoverSheet tmdbId={lastDiscover} mediaType={lastDiscoverType} leaving={discover.leaving} />
      ) : null}
    </>
  );
}
