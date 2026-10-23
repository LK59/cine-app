"use client";

import { useEffect, useState } from "react";
import useSWR from "swr";
import { fetcher } from "@/lib/swr";
import { cinemaNavigate, useCinemaRoute } from "@/lib/cinemaRoute";
import { usePlayback } from "@/components/PlaybackProvider";
import { NEWS_KEY } from "@/lib/news/events";
import { NEWS_SHOW_DELAY_MS, shouldOfferNews } from "@/lib/news/decide";
import type { NewsPageView, NewsPayload } from "@/lib/news/content";
import { NewsDialog } from "@/components/news/NewsDialog";
import { PROMPT_RANK, useFloatingPromptTurn } from "@/lib/floatingPromptTurn";

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

  // Un compte neuf passe son écran d'accueil d'abord, et voit les nouveautés au lancement suivant
  // (`shouldOfferNews`). Cet écran fini ne relit pas `/api/onboarding` : une relecture plus tard
  // dans la séance (retour du réseau) répondait `pending: false`, et la fenêtre surgissait au milieu
  // de cette même séance (13/10/2026). Vu « à faire » une fois, ce chargement n'en montre pas.
  if (onboarding?.pending && phase === "waiting") setPhase("done");

  const eligible =
    phase === "waiting" &&
    shouldOfferNews({ unseen: data ? data.unseen.length : null, onboardingPending: onboarding?.pending, playback: mode, route, pathname });

  useEffect(() => {
    if (!eligible) return;
    const timer = setTimeout(() => setPhase("open"), NEWS_SHOW_DELAY_MS);
    return () => clearTimeout(timer);
  }, [eligible]);

  /**
   * Les pages montrées, figées à l'ouverture.
   *
   * La fenêtre éteint le drapeau dès qu'elle s'affiche (`markNewsSeen`) ; une relecture de la clé
   * pendant qu'on lit — `revalidateOnReconnect`, un passage du Wi-Fi au réseau mobile — répond
   * alors `unseen: []`. Recalculées sur cette réponse, les pages devenaient vides et la fenêtre
   * disparaissait sous les yeux, sans fermeture : ni `closedBy` ni `shownMs` au journal (13/10/2026).
   */
  const [shown, setShown] = useState<{ pages: NewsPageView[]; auto: boolean } | null>(null);
  if (phase === "open" && shown === null && data) {
    setShown({ pages: data.pages.filter((p) => data.unseen.includes(p.id)), auto: !data.relaunched });
  }

  // Une invitation à la fois (`floatingPromptTurn`) : la fenêtre ouverte, les invitations attendent.
  useFloatingPromptTurn("news", PROMPT_RANK.step, phase === "open" && !!shown && shown.pages.length > 0);
  if (phase !== "open" || !shown) return null;
  const pages = shown.pages;
  if (pages.length === 0) return null;
  return (
    <NewsDialog
      pages={pages}
      auto={shown.auto}
      onClose={(by) => {
        setPhase("done");
        if (by === "voir-plus") cinemaNavigate({ news: `corrections:${pages[0].id}` });
      }}
    />
  );
}
