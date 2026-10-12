"use client";

import { useEffect, useState } from "react";
import useSWR from "swr";
import { fetcher } from "@/lib/swr";
import { cinemaNavigate, useCinemaRoute } from "@/lib/cinemaRoute";
import { usePlayback } from "@/components/PlaybackProvider";
import { NEWS_KEY } from "@/lib/news/events";
import { NEWS_SHOW_DELAY_MS, shouldOfferNews } from "@/lib/news/decide";
import type { NewsPayload } from "@/lib/news/content";
import { NewsDialog } from "@/components/news/NewsDialog";

/**
 * Ouvre la fenêtre des Nouveautés quand il le faut — monté une fois par la coquille du cinéma,
 * pour le bureau comme pour le téléphone (DECISIONS.md §73). La décision est `shouldOfferNews` ;
 * ce composant n'y ajoute que l'attente (`NEWS_SHOW_DELAY_MS`, recommencée si l'accueil cesse
 * d'être seul à l'écran) et le « une fois par chargement ».
 *
 * « Voir plus » ferme la fenêtre et ouvre Compte → Nouveautés sur la liste des corrections de la
 * page la plus récente.
 */
export function NewsGate() {
  const route = useCinemaRoute();
  const { mode } = usePlayback();
  const { data: onboarding } = useSWR<{ pending: boolean }>("/api/onboarding", fetcher, { revalidateOnFocus: false });
  const { data } = useSWR<NewsPayload>(NEWS_KEY, fetcher, { revalidateOnFocus: false });
  const [phase, setPhase] = useState<"waiting" | "open" | "done">("waiting");
  const [pathname] = useState(() => (typeof window === "undefined" ? "" : window.location.pathname));

  const eligible =
    phase === "waiting" &&
    shouldOfferNews({ unseen: data ? data.unseen.length : null, onboardingPending: onboarding?.pending, playback: mode, route, pathname });

  useEffect(() => {
    if (!eligible) return;
    const timer = setTimeout(() => setPhase("open"), NEWS_SHOW_DELAY_MS);
    return () => clearTimeout(timer);
  }, [eligible]);

  if (phase !== "open" || !data) return null;
  const pages = data.pages.filter((p) => data.unseen.includes(p.id));
  if (pages.length === 0) return null;
  return (
    <NewsDialog
      pages={pages}
      auto={!data.relaunched}
      onClose={(by) => {
        setPhase("done");
        if (by === "voir-plus") cinemaNavigate({ news: `corrections:${pages[0].id}` });
      }}
    />
  );
}
