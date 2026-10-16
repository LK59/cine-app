"use client";

import { useSyncExternalStore } from "react";
import { Tablet } from "lucide-react";
import { useT } from "@/components/TranslationProvider";
import { ipadSimulatorOn, setIpadSimulator } from "@/lib/ipadSimulator";

/** Fixé au chargement : entrer ou sortir recharge la page, rien n'a à être suivi entre-temps. */
const noSubscribe = () => () => {};

export function useIpadSimulator(): boolean {
  return useSyncExternalStore(noSubscribe, ipadSimulatorOn, () => false);
}

/** La sortie du simulateur d'iPad, toujours à l'écran tant qu'il est actif (`ipadSimulator.ts`). */
export function IpadSimulatorBadge() {
  const t = useT();
  const on = useIpadSimulator();
  if (!on) return null;
  return (
    <button
      type="button"
      onClick={() => setIpadSimulator(false)}
      className="fixed bottom-3 left-3 z-[200] flex items-center gap-2 rounded-full bg-black/80 px-4 py-2 text-sm font-medium text-white ring-1 ring-white/20"
    >
      <Tablet size={16} />
      {t("player.account.ipadSimQuit")}
    </button>
  );
}
