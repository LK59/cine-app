"use client";

import { endReplayUsage, replayLogFields } from "@/lib/replaySubtitles";
import { useCallback, useEffect, useRef, type RefObject } from "react";
import { reportPlayback } from "@/lib/reportPlayback";
import { clearUnsentStop, saveUnsentStop, touchUnsentStop } from "@/lib/unsentStop";
import { newPlayerSessionId, watchElementWaits, WatchedClock } from "@/lib/playerSessionTally";
import type { OfflineDownload } from "@/lib/offline/downloads";

/**
 * La séance du lecteur hors ligne au journal du lecteur (02/11/2026) : un `start` et un `stop`,
 * rien d'autre — `player: "hors-ligne"`.
 *
 * Il n'écrivait rien : il rapportait sa position à Jellyfin et c'était tout. La première personne à
 * regarder ses téléchargements pour de bon a vu deux semaines de séries passer sous le nez de la page
 * Activité, et d'un point des statistiques qui l'a crue sur Jellyfin directement — seul Jellyfin les
 * voyait.
 *
 * Sans réseau, rien ne se perd : une ligne qui ne part pas attend dans la file de l'appareil
 * (`unsentLines.ts`) et repart, datée de son premier envoi, au retour du réseau ; une page qu'iOS tue
 * laisse son bilan dans `unsentStop`, envoyé au lancement suivant (`why: "lost"`). Le temps regardé
 * se compte comme en ligne (`WatchedClock`) : en lecture, sans attente.
 */
export function useOfflineSessionLog(
  videoRef: RefObject<HTMLVideoElement | null>,
  ready: boolean,
  download: OfflineDownload | null | undefined,
  counts: RefObject<{ device: number; server: number }>
): { endAs: (why: "next") => void } {
  const sessionRef = useRef<string | null>(null);
  const whyRef = useRef<"close" | "next">("close");
  const sentRef = useRef(false);

  useEffect(() => {
    const video = videoRef.current;
    if (!ready || !video || !download || sessionRef.current) return;
    const session = newPlayerSessionId();
    sessionRef.current = session;
    // Ce que les deux lignes disent du titre, figé à l'ouverture : un épisode vu jusqu'au bout peut
    // quitter l'appareil (`markOfflineWatched`) avant que le lecteur se ferme.
    const facts = {
      session,
      player: "hors-ligne",
      path: "hors-ligne",
      itemId: download.itemId,
      title: download.title,
      agent: navigator.userAgent,
      video: download.codec,
      quality: download.quality,
      audio: download.audioLabel,
    };
    reportPlayback("start", {
      ...facts,
      resumeAt: Math.round(video.currentTime),
      // Le réseau à l'ouverture : avec lui, la fin d'un fichier pas encore arrivé se lit sur le serveur.
      network: navigator.onLine !== false,
      downloadState: download.state,
    });

    const clock = new WatchedClock();
    const unwatch = watchElementWaits(video, clock);
    if (!video.paused) clock.run(Date.now());
    const onPlay = () => clock.run(Date.now());
    const onPause = () => clock.halt(Date.now());
    let ended = false;
    const onEnded = () => {
      ended = true;
    };
    video.addEventListener("play", onPlay);
    video.addEventListener("pause", onPause);
    video.addEventListener("ended", onEnded);

    const stopFields = () => ({
      ...facts,
      watched: clock.seconds(Date.now()),
      at: Math.round(video.currentTime),
      ended,
      deviceMB: Math.round(counts.current.device / 1e5) / 10,
      serverMB: Math.round(counts.current.server / 1e5) / 10,
      // Les sous-titres d'un passage rejoué (§150) — rien tant qu'aucune aide n'a paru.
      ...replayLogFields(download.itemId),
    });
    // Le bilan gardé sur l'appareil, réécrit quand il a changé, et à chaque passage en arrière-plan :
    // c'est là qu'iOS tue une page.
    let saved = "";
    const keep = () => {
      const fields = stopFields();
      const key = `${fields.watched}|${fields.at}|${fields.ended}`;
      if (key === saved) {
        touchUnsentStop(session);
        return;
      }
      saved = key;
      saveUnsentStop(session, fields, Date.now(), { livesHere: true });
    };
    keep();
    const timer = setInterval(keep, 30_000);
    const onHidden = () => {
      if (document.visibilityState === "hidden") keep();
    };
    document.addEventListener("visibilitychange", onHidden);
    window.addEventListener("pagehide", keep);

    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onHidden);
      window.removeEventListener("pagehide", keep);
      video.removeEventListener("play", onPlay);
      video.removeEventListener("pause", onPause);
      video.removeEventListener("ended", onEnded);
      unwatch();
      if (sentRef.current) return;
      sentRef.current = true;
      reportPlayback("stop", { ...stopFields(), why: whyRef.current });
      endReplayUsage(download.itemId);
      clearUnsentStop(session);
    };
    // Une séance par ouverture : l'hôte change de clé avec elle.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);

  const endAs = useCallback((why: "next") => {
    whyRef.current = why;
  }, []);
  return { endAs };
}
