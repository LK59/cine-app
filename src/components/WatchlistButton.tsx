"use client";

import { useState } from "react";
import useSWR, { useSWRConfig } from "swr";
import { fetcher } from "@/lib/swr";
import { Bookmark, BookmarkCheck } from "lucide-react";
import type { WatchlistItem, WatchlistStatus } from "@/lib/db";
import { useT } from "@/components/TranslationProvider";

interface Props {
  mediaType: "movie" | "series";
  tmdbId: number;
  title: string;
  year?: number | null;
  posterPath?: string | null;
  defaultStatus?: WatchlistStatus;
  size?: "sm" | "md";
  className?: string;
}

export function WatchlistButton({
  mediaType, tmdbId, title, year, posterPath, defaultStatus = "to_watch", size = "md", className = ""
}: Props) {
  const { mutate } = useSWRConfig();
  const t = useT();
  const [busy, setBusy] = useState(false);

  const itemKey = `/api/watchlist/item?mediaType=${mediaType}&tmdbId=${tmdbId}`;
  const { data } = useSWR<{ item: WatchlistItem | null }>(itemKey, fetcher, { shouldRetryOnError: false });
  const inList = !!data?.item;

  async function toggle() {
    if (busy) return;
    setBusy(true);
    const wasInList = !!data?.item;
    // Optimistic flip — update UI immediately
    mutate(itemKey, { item: wasInList ? null : { tmdbId, mediaType, title } as WatchlistItem }, { revalidate: false });
    try {
      if (wasInList) {
        const res = await fetch("/api/watchlist", {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ tmdbId, mediaType }),
        });
        if (!res.ok) throw new Error();
      } else {
        const res = await fetch("/api/watchlist", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mediaType, tmdbId, title, year, posterPath, status: defaultStatus }),
        });
        if (!res.ok) throw new Error();
      }
      // Fire-and-forget: a revalidation failure here shouldn't surface as an unhandled promise
      // rejection (the optimistic UI is already correct either way).
      mutate(itemKey).catch(() => {});
      mutate("/api/watchlist").catch(() => {});
    } catch {
      mutate(itemKey); // rollback on error
    } finally {
      setBusy(false);
    }
  }

  const Icon = inList ? BookmarkCheck : Bookmark;
  const label = inList ? t('search.removeFromList') : t('search.addToList');
  const iconSize = size === "sm" ? 13 : 16;

  return (
    <button
      onClick={toggle}
      disabled={busy}
      title={label}
      aria-pressed={inList}
      // Ce bouton était resté en dehors du système : `rounded` au lieu de `rounded-lg`, un fond
      // deux fois plus discret et un texte deux tons plus sombre que ses voisins. Posé entre
      // « Marquer vu » et « Bande-annonce », il avait l'air désactivé. `btn-on` est la façon dont
      // le reste de l'app dit « c'est l'option retenue » — ici, « ce titre est dans la liste ».
      className={`btn btn-ghost ${inList ? "btn-on" : ""} ${size === "sm" ? "btn-icon" : ""} ${className}`}
    >
      <Icon size={iconSize} />
      {/* Le libellé court : la rangée d'actions d'une fiche en porte déjà quatre autres, et
          « Ajouter à la liste » l'y ferait passer à la ligne. L'intitulé complet est dans
          l'infobulle et dans le nom accessible. */}
      {size === "md" && <span>{inList ? t('search.removeFromList') : t('common.add')}</span>}
    </button>
  );
}
