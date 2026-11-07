"use client";

import { useEffect, useLayoutEffect, useRef } from "react";
import dynamic from "next/dynamic";
import { PlayerPanelFrame } from "./PlayerPanelFrame";
import { useT } from "@/components/TranslationProvider";
import { decodeView } from "@/components/activity/nav";
import { ActivityOverview } from "@/components/activity/views/ActivityOverview";
import { ActivityAccount } from "@/components/activity/views/ActivityAccount";
import { ActivityLogs } from "@/components/activity/views/ActivityLogs";
import { ReportThread } from "@/components/reports/ReportThread";
import { ActivitySeance } from "@/components/activity/views/ActivitySeance";
import { ActivityNews } from "@/components/activity/views/ActivityNews";
import { ActivityDownloads } from "@/components/activity/views/ActivityDownloads";
import { ActivityShares } from "@/components/activity/views/ActivityShares";
import { ActivityReadings } from "@/components/activity/views/ActivityReadings";

// Chargé à l'ouverture seulement : ses gestes, ses matières et sa feuille de style ne concernent
// que l'administrateur qui l'ouvre.
const AnimationLab = dynamic(() => import("@/components/animlab/AnimationLab").then((m) => m.AnimationLab), { ssr: false });

/**
 * L'activité des comptes, dans le cinéma — pour l'administrateur.
 *
 * Un panneau et non une page de la gestion : on y arrive depuis le panneau Compte, qu'il remplace,
 * et le retour y ramène ; sans la barre latérale de la gestion, qu'il fallait traverser (demandé le
 * 24/09/2026). Chaque vue — vue d'ensemble, fiche, journaux, séance — est une entrée d'historique.
 *
 * **La vue d'ensemble reste montée sous les autres** (07/11/2026). Chaque vue était un panneau monté
 * à neuf : revenir d'une fiche reconstruisait tout le tableau de bord — animation d'entrée, rendu de
 * chaque encadré, requêtes relancées, défilement à retrouver —, et c'était là qu'on attendait. Elle
 * est maintenant cachée, pas démontée, pendant qu'une autre vue est ouverte : le retour la rend telle
 * qu'on l'a laissée, à la même hauteur. Les routes d'API refusent tout autre compte que
 * l'administrateur ; l'écran n'en montre alors que l'erreur.
 */
export function PlayerActivityPanel({ raw, leaving }: { raw: string; leaving?: boolean }) {
  const t = useT();
  const view = decodeView(raw) ?? { kind: "overview" as const };
  const title =
    view.kind === "logs" ? t("activity.logs.title")
    : view.kind === "report" ? t("report.ui.threadTitle")
    : view.kind === "animations" ? t("player.account.animLab")
    : view.kind === "news" ? t("news.title")
    : view.kind === "downloads" ? t("activity.downloads.title")
    : view.kind === "shares" ? t("activity.shares.title")
    : view.kind === "readings" ? t("activity.readings.title")
    : t("activity.title");
  const onOverview = view.kind === "overview";
  const anchor = useRef<HTMLDivElement>(null);
  useViewScroll(anchor, raw);
  return (
    <PlayerPanelFrame contentWidth="80rem" title={title} back leaving={leaving}>
      <div ref={anchor} className="mx-auto w-full max-w-7xl space-y-6 pt-2">
        {/* Cachée, pas démontée : voir plus haut. `inert` la sort du clavier et des lecteurs d'écran. */}
        <div hidden={!onOverview} inert={!onOverview}>
          <ActivityOverview active={onOverview} />
        </div>
        {!onOverview && (
          <div key={raw} className="animate-slide-in-right space-y-6">
            {view.kind === "account" && <ActivityAccount id={view.id} />}
            {view.kind === "logs" && <ActivityLogs preset={view.preset} />}
            {view.kind === "seance" && <ActivitySeance id={view.id} />}
            {view.kind === "report" && <ReportThread id={view.id} />}
            {view.kind === "animations" && <AnimationLab />}
            {view.kind === "news" && <ActivityNews />}
            {view.kind === "downloads" && <ActivityDownloads />}
            {view.kind === "shares" && <ActivityShares />}
            {view.kind === "readings" && <ActivityReadings />}
          </div>
        )}
      </div>
    </PlayerPanelFrame>
  );
}

/**
 * La hauteur de chaque vue, gardée le temps du panneau : on part d'une vue, on y revient à la même
 * hauteur ; une vue neuve s'ouvre en haut. Le corps défilant est celui du cadre (`PlayerPanelFrame`),
 * retrouvé depuis le contenu.
 */
function useViewScroll(anchor: React.RefObject<HTMLDivElement | null>, raw: string): void {
  const positions = useRef(new Map<string, number>());
  const current = useRef(raw);
  useEffect(() => {
    const body = scrollParent(anchor.current);
    if (!body) return;
    const onScroll = () => positions.current.set(current.current, body.scrollTop);
    body.addEventListener("scroll", onScroll, { passive: true });
    return () => body.removeEventListener("scroll", onScroll);
  }, [anchor]);
  useLayoutEffect(() => {
    if (current.current === raw) return;
    current.current = raw;
    const body = scrollParent(anchor.current);
    if (body) body.scrollTop = positions.current.get(raw) ?? 0;
  }, [anchor, raw]);
}

function scrollParent(node: HTMLElement | null): HTMLElement | null {
  for (let el = node?.parentElement ?? null; el; el = el.parentElement) {
    const overflow = getComputedStyle(el).overflowY;
    if (overflow === "auto" || overflow === "scroll") return el;
  }
  return null;
}
