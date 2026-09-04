"use client";

import { useEffect } from "react";
import dynamic from "next/dynamic";
import { useIsMobile } from "@/lib/useIsMobile";
import { cinemaClose, cinemaNavigate, useCinemaRoute } from "@/lib/cinemaRoute";
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

/**
 * La coquille du lecteur : la navigation, et les écrans qu'elle ouvre.
 *
 * L'écran cinéma lui-même n'est pas ici — il est rendu par la page, et se porte dans
 * document.body. Cette séparation est volontaire : la coquille doit pouvoir changer sans toucher
 * aux neuf cents lignes de la grille, et la grille doit pouvoir s'ouvrir sans coquille (c'est ce
 * qui se passait avant ce chantier).
 */
export function PlayerShell() {
  const isMobile = useIsMobile();
  const route = useCinemaRoute();

  // La variable vit sur l'élément racine parce que c'est le seul ancêtre commun entre le rail et
  // un écran porté dans document.body. Elle est remise à zéro sur téléphone, où la navigation est
  // un tiroir et ne réserve rien.
  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty("--player-rail", isMobile ? "0px" : RAIL_WIDTH);
    return () => {
      root.style.removeProperty("--player-rail");
    };
  }, [isMobile]);

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
      {route.search && <PlayerSearchPanel />}
      {route.list && <PlayerListPanel />}
      {route.account && <PlayerAccountPanel />}
      {route.discover !== null && <PlayerDiscoverSheet tmdbId={route.discover} mediaType={route.discoverType} />}
      {route.person !== null && <PlayerPersonSheet tmdbId={route.person} />}
    </>
  );
}
