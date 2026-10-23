"use client";

/**
 * Les chapitres et les aperçus de la barre d'un titre : leur chargement, le préchauffage des
 * planches après la première image, et la planche d'un instant. Sortis de `PlayerControls` tels quels.
 */

import { useEffect, useState, type RefObject } from "react";
import { trickplayTileAt as sharedTrickplayTileAt, trickplayTileIndex, trickplayTileOrder, type TrickplayInfo } from "@/lib/trickplayTile";
import { afterFirstPicture } from "@/lib/firstPicture";

/** Le nombre de planches d'aperçus : chacune en porte `tileWidth × tileHeight`. */
function trickplayTileCount(info: TrickplayInfo): number {
  return Math.ceil(info.thumbnailCount / (info.tileWidth * info.tileHeight));
}

export function useChapters(itemId: string, lab: boolean) {
  const [chapters, setChapters] = useState<{ start: number; name: string | null }[]>([]);

  // Chapters — fetched once per item, same shape/lifecycle as the trickplay metadata below.
  useEffect(() => {
    if (lab) return;
    let cancelled = false;
    fetch(`/api/jellyfin/chapters?itemId=${itemId}`)
      .then((r) => (r.ok ? r.json() : []))
      .then((data) => {
        if (!cancelled) setChapters(Array.isArray(data) ? data : []);
      })
      .catch(() => {
        if (!cancelled) setChapters([]);
      });
    return () => {
      cancelled = true;
    };
  }, [itemId, lab]);

  return chapters;
}

export function useTrickplay(
  itemId: string,
  lab: boolean,
  offlineTrickplay: { info: TrickplayInfo; urls: string[] } | null,
  videoRef: RefObject<HTMLVideoElement | null>
) {
  // Trickplay scrubbing preview — fetched once per item, not per hover: it's item-wide static
  // metadata (grid layout + a handful of sprite-sheet tiles covering the whole runtime), so
  // there's nothing to re-fetch as the seek bar is dragged, only tiles to look up locally.
  const [fetchedTrickplay, setTrickplay] = useState<TrickplayInfo | null>(null);
  const trickplay = offlineTrickplay?.info ?? fetchedTrickplay;
  const hasOfflineTrickplay = offlineTrickplay !== null;
  useEffect(() => {
    if (lab || hasOfflineTrickplay) return;
    let cancelled = false;
    fetch(`/api/jellyfin/trickplay/info?itemId=${itemId}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!cancelled) setTrickplay(data);
      })
      .catch(() => {
        if (!cancelled) setTrickplay(null);
      });
    return () => {
      cancelled = true;
    };
  }, [itemId, lab, hasOfflineTrickplay]);

  // Pre-warms the browser's own HTTP cache with every trickplay sprite tile as soon as the
  // metadata is known, instead of only fetching a tile the first time the seek bar is actually
  // hovered — trades a bit of upfront bandwidth (a handful of small JPEGs — Jellyfin packs
  // hundreds of thumbnails per tile) for the preview never showing a blank/loading frame on
  // the first scrub. Fire-and-forget: nothing reads the Image objects, only their side effect
  // of populating the cache under the same URL updatePreview will request later.
  //
  // Essayé le 08/10/2026 : chauffer au premier survol seulement (2,4 Mo de moins par ouverture).
  // Rendu le jour même — une à deux secondes sans aperçu au premier contact, exactement ce que
  // ce préchargement existe pour éviter.
  //
  // **Après la première image, la planche de la position d'abord, puis une à une** (15/10/2026,
  // LECTEUR-6). Toutes partaient ensemble au montage, avant le film : sur un lien à 2 Mbit/s, neuf
  // planches (≈ 7 Mo) occupaient le lien de 13 à 39 s, l'init du film n'était demandée qu'à 30 s, la
  // première image arrivait à 42 s — le lien suffisait au film, pas au film plus les vignettes. Le
  // préchargement reste automatique (ce n'est pas le « premier toucher » écarté le 08/10) ; seul son
  // moment change : dès que l'élément joue (`playing`), ou qu'il a de quoi jouer hors d'un saut
  // (`readyState` ≥ 3 — un film mis en pause à l'ouverture, ou un composant remonté sur un film qui
  // joue). Pas sur le `canplay` de la position 0 que le lecteur serveur a avant de sauter à la reprise :
  // `seeking` l'écarte, la planche choisie est celle de l'endroit où l'image arrive. Ensuite la plus
  // proche d'abord, une requête à la fois — sur un bon lien elles sont toutes là en une seconde ou
  // deux, bien avant le premier geste.
  useEffect(() => {
    // Gardées sur l'appareil : rien à faire venir.
    if (!trickplay || hasOfflineTrickplay) return;
    const tileCount = trickplayTileCount(trickplay);
    if (!(tileCount > 0)) return;
    const video = videoRef.current;
    let cancelled = false;
    const loadFrom = (order: number[]) => {
      const next = order.shift();
      if (cancelled || next === undefined) return;
      const img = new Image();
      // Échouée ou chargée, la suivante : l'aperçu demandera lui-même une planche manquante.
      img.onload = img.onerror = () => loadFrom(order);
      img.src = `/api/jellyfin/trickplay/tile?itemId=${itemId}&width=${trickplay.width}&index=${next}`;
    };
    const detach = afterFirstPicture(video, () => {
      if (cancelled) return;
      const position = video && Number.isFinite(video.currentTime) ? video.currentTime : 0;
      const first = trickplayTileIndex(trickplay, position, tileCount);
      loadFrom(trickplayTileOrder(first, tileCount));
    });
    return () => {
      cancelled = true;
      detach();
    };
  }, [trickplay, itemId, videoRef, hasOfflineTrickplay]);

  // Shared by the seek-bar hover preview and the chapters menu thumbnails below — same sprite
  // lookup math, just called at a different `time`. Plain function, not useCallback: same
  // reasoning as updatePreview in PlayerControls (nothing needs referential stability, and the React
  // Compiler's memoization check gets confused by unrelated nearby state).
  function trickplayTileAt(time: number): { url: string; bgX: number; bgY: number } | null {
    // Le calcul est partagé avec les répliques de la recherche (`trickplayTile.ts`, §88).
    if (!trickplay) return null;
    const tile = sharedTrickplayTileAt(trickplay, itemId, time);
    if (!offlineTrickplay) return tile;
    const url = offlineTrickplay.urls[trickplayTileIndex(trickplay, time, trickplayTileCount(trickplay))];
    return url ? { ...tile, url } : null;
  }

  return { trickplay, trickplayTileAt };
}
