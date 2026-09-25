"use client";

import { useEffect, useRef, useSyncExternalStore } from "react";
import { usePlayback } from "@/components/PlaybackProvider";
import { benchStore } from "@/lib/playerBench/store";
import { APP_BUILD } from "@/lib/appBuild";
import { alreadyReloadedFor, holdsUnsavedText, isStaleBuild, markReloadedFor, mayReloadNow } from "@/lib/staleBuild";

/** Combien de temps un onglet resté au premier plan attend avant de reposer la question. */
const CHECK_INTERVAL_MS = 30 * 60 * 1000;

/**
 * Après la fermeture d'un film, le temps que partent les derniers comptes rendus — la position
 * rendue à Jellyfin, le bilan de séance. Un rechargement immédiat les coupait.
 */
const AFTER_CLOSE_MS = 5000;

/**
 * Les champs où quelqu'un a tapé — voir `holdsUnsavedText`. Retirés dès qu'ils ne comptent plus,
 * pour que l'ensemble ne retienne pas des formulaires fermés depuis longtemps.
 */
const touched = new Set<Element>();

function unsaved(): boolean {
  for (const element of touched) {
    if (holdsUnsavedText(element)) return true;
    touched.delete(element);
  }
  return false;
}

/** Recharge si le serveur sert un autre build et que le moment ne coûte rien. */
function reloadIfSafe(served: string | null, moment: { filmOpen: boolean; benchRunning: boolean }): void {
  if (!served) return;
  if (!mayReloadNow({ ...moment, typing: typing(), unsaved: unsaved() })) return;
  if (alreadyReloadedFor(served)) return;
  markReloadedFor(served);
  window.location.reload();
}

function typing(): boolean {
  const el = typeof document !== "undefined" ? document.activeElement : null;
  if (!el) return false;
  return el.matches("input, textarea, select, [contenteditable]:not([contenteditable='false'])");
}

/**
 * Recharge un onglet plus vieux que le serveur, sans rien afficher — voir `staleBuild.ts`.
 *
 * Remplace la bannière « Nouvelle version disponible », qui ne pouvait pas apparaître. Les
 * moments choisis sont ceux où personne ne regarde, ou où rien n'est en cours — ni film, ni texte
 * tapé et pas encore envoyé : quand l'onglet passe à l'arrière-plan, quand il revient au premier
 * plan, et quelques secondes après la fermeture d'un film. Un contrôle périodique ne fait que
 * constater ; il ne recharge jamais une page sous les yeux de quelqu'un qui la parcourt.
 */
export function BuildRefresh() {
  const { session } = usePlayback();
  const benchPhase = useSyncExternalStore(benchStore.subscribe, () => benchStore.get().phase, () => "idle" as const);
  /** Le build servi, une fois qu'il diffère du nôtre. */
  const served = useRef<string | null>(null);
  const moment = useRef({ filmOpen: session !== null, benchRunning: benchPhase !== "idle" });

  useEffect(() => {
    let cancelled = false;
    const check = async (thenReload: boolean) => {
      try {
        const res = await fetch("/api/version", { cache: "no-store" });
        if (!res.ok) return;
        const body = (await res.json()) as { build?: unknown };
        if (cancelled || !isStaleBuild(APP_BUILD, body.build)) return;
        served.current = body.build as string;
        if (thenReload) reloadIfSafe(served.current, moment.current);
      } catch {
        // Hors ligne, ou le serveur redémarre : la question sera reposée.
      }
    };
    const onInput = (event: Event) => {
      if (event.target instanceof Element) touched.add(event.target);
    };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") reloadIfSafe(served.current, moment.current);
      else void check(true);
    };
    document.addEventListener("visibilitychange", onVisibility);
    // En capture : un champ qui arrête la propagation de ses événements compte quand même.
    document.addEventListener("input", onInput, true);
    const interval = setInterval(() => void check(false), CHECK_INTERVAL_MS);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisibility);
      document.removeEventListener("input", onInput, true);
      clearInterval(interval);
    };
  }, []);

  useEffect(() => {
    const wasOpen = moment.current.filmOpen;
    moment.current = { filmOpen: session !== null, benchRunning: benchPhase !== "idle" };
    if (!wasOpen || session !== null || !served.current) return;
    const timer = setTimeout(() => reloadIfSafe(served.current, moment.current), AFTER_CLOSE_MS);
    return () => clearTimeout(timer);
  }, [session, benchPhase]);

  return null;
}
