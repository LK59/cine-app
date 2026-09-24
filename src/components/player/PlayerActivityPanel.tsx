"use client";

import { PlayerPanelFrame } from "./PlayerPanelFrame";
import { useT } from "@/components/TranslationProvider";
import { decodeView } from "@/components/activity/nav";
import { ActivityOverview } from "@/components/activity/views/ActivityOverview";
import { ActivityAccount } from "@/components/activity/views/ActivityAccount";
import { ActivityLogs } from "@/components/activity/views/ActivityLogs";
import { ActivitySeance } from "@/components/activity/views/ActivitySeance";

/**
 * L'activité des comptes, dans le cinéma — pour l'administrateur.
 *
 * Un panneau et non une page de la gestion : on y arrive depuis le panneau Compte, qu'il remplace,
 * et le retour y ramène ; sans la barre latérale de la gestion, qu'il fallait traverser (demandé le
 * 24/09/2026). Chaque vue — vue d'ensemble, fiche, journaux, séance — est une entrée
 * d'historique, donc un écran à part : la coquille le monte sous une clé par vue. Les routes
 * d'API refusent tout autre compte que l'administrateur ; l'écran n'en montre alors que l'erreur.
 */
export function PlayerActivityPanel({ raw, leaving }: { raw: string; leaving?: boolean }) {
  const t = useT();
  const view = decodeView(raw) ?? { kind: "overview" as const };
  const title = view.kind === "logs" ? t("activity.logs.title") : t("activity.title");
  return (
    <PlayerPanelFrame title={title} back leaving={leaving}>
      <div className="mx-auto w-full max-w-7xl space-y-6 pt-2">
        {view.kind === "overview" && <ActivityOverview />}
        {view.kind === "account" && <ActivityAccount id={view.id} />}
        {view.kind === "logs" && <ActivityLogs preset={view.preset} />}
        {view.kind === "seance" && <ActivitySeance id={view.id} />}
      </div>
    </PlayerPanelFrame>
  );
}
