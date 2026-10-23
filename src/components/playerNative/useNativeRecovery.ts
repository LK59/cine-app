// Deux retours du lecteur natif (`ExperimentalPlayerHost.tsx`) : la source que la plateforme a fermée
// pendant que la page était cachée, reconstruite au retour au premier plan ; et le réseau revenu
// après une coupure, guetté puis relancé avec un délai qui s'espace. Sorti tel quel de l'hôte le
// 23/10/2026, appelé à la même place : l'écouteur `visibilitychange` est posé dans le même ordre.
import { useEffect, type Dispatch, type RefObject, type SetStateAction } from "react";
import { reportPlayback } from "@/lib/reportPlayback";
import { rebuildLine } from "@/components/player/nativeHostHelpers";
import type { BackgroundWatch } from "@/lib/backgroundReturn";
import type { PlayerLifecycle } from "@/lib/playerLifecycle";
import type { SessionTally } from "@/lib/playerSessionTally";
import type { RemuxPlayback } from "@/lib/webcodecs/remuxPlayback";

export function useNativeRecovery({
  path,
  restart,
  lifecycle,
  background,
  tally,
  networkLost,
  online,
  setOnline,
  retryAfterNetwork,
  remuxRef,
  positionRef,
  describeFileRef,
}: {
  path: "remux" | null;
  restart: (at: number, why: string, byViewer?: boolean) => void;
  lifecycle: PlayerLifecycle;
  background: BackgroundWatch;
  tally: SessionTally;
  networkLost: { message: string; at: number; audio: number | null } | null;
  online: boolean;
  setOnline: Dispatch<SetStateAction<boolean>>;
  retryAfterNetwork: (at: number, why: string, byViewer?: boolean) => void;
  remuxRef: RefObject<RemuxPlayback | null>;
  positionRef: RefObject<number>;
  describeFileRef: RefObject<() => Record<string, unknown>>;
}): void {
  // Watches for the platform having taken the source away while the page was not on screen. The
  // check runs on returning to the foreground, and once more a moment later: on iOS the closure
  // is not always visible in the same task as the visibility change.
  useEffect(() => {
    if (path !== "remux") return;
    const check = () => {
      const playback = remuxRef.current;
      if (!playback?.lost) return;
      // Un retour qui laisse la lecture en pause (`holdPausedOnReturn`) : la reconstruction aussi,
      // au même endroit un peu en arrière. Un film fini aussi : reconstruit en lecture, il rejouait
      // tout seul ses deux dernières secondes et annonçait sa fin une seconde fois (24/09/2026).
      // Les deux règles, et le budget, sont dans `lifecycle.backgroundLost`.
      const at = lifecycle.backgroundLost(
        { position: playback.position || positionRef.current, hold: background.currentHold() },
        Date.now()
      );
      if (at === null) return;
      // Écrit au journal, et plus seulement dans la trace : une reconstruction au retour se lisait
      // comme une ouverture de plus, et combien de retours d'arrière-plan en coûtent une restait
      // une question sans réponse (23/09/2026).
      tally.backgroundRebuilt();
      reportPlayback("rebuild", rebuildLine(describeFileRef.current(), "source fermée en arrière-plan", at, { hiddenMs: tally.lastBackgroundMs }));
      restart(at, "la plateforme a fermé la source");
    };
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      check();
      setTimeout(check, 400);
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [path, restart, lifecycle, background, tally, describeFileRef, positionRef, remuxRef]);

  // Watched only while something is waiting on it: an idle player has no use for the news.
  useEffect(() => {
    if (!networkLost) return;
    const update = () => setOnline(navigator.onLine !== false);
    update();
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, [networkLost, setOnline]);

  // Back on its own, so the viewer does not have to notice before the film can.
  //
  // Espacé à chaque échec : « en ligne » dit que le téléphone a du réseau, pas que le serveur
  // répond. Pendant un redéploiement — plusieurs par jour — le lecteur relançait toutes les
  // 0,8 s, sans fin, une reconstruction vouée à échouer (relu le 22/09/2026). 0,8 s, puis 1,6,
  // 3,2… jusqu'à 30 s ; le compte repart à zéro dès qu'une image est revenue.
  useEffect(() => {
    if (!networkLost || !online || lifecycle.isOver()) return;
    const at = networkLost.at;
    const delay = lifecycle.networkRetryDelay();
    const id = setTimeout(() => {
      if (!lifecycle.mayRebuild()) return;
      lifecycle.noteNetworkRetry();
      retryAfterNetwork(at, "le réseau est revenu");
    }, delay);
    return () => clearTimeout(id);
  }, [networkLost, online, retryAfterNetwork, lifecycle]);
}
