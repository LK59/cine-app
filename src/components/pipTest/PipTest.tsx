"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { APP_BUILD } from "@/lib/appBuild";

/**
 * La page de test « image dans l'image » (`/pip-test`, 16/11/2026, administrateur seul).
 *
 * Elle existe pour un rapport à Apple : montrer, sur un iPhone, que l'image dans l'image marche dans un
 * onglet Safari et pas dans l'application posée sur l'écran d'accueil. Rien de Laterna n'y joue — une mire
 * synthétique (aucun film, aucun droit) lue de trois façons :
 *
 * - **A** : `<video src>` sur un MP4, le cas le plus simple qui soit ;
 * - **B** : ManagedMediaSource alimentée en une fois, ouverte comme le fait notre lecteur
 *   (`disableRemotePlayback`, `srcObject`, `mseSource.ts`) ;
 * - **C** : HLS natif (`.m3u8` en fMP4), la piste d'un futur remux côté serveur.
 *
 * Les textes sont en anglais, sans traduction : la page est filmée pour des ingénieurs d'Apple. Chaque
 * geste et chaque évènement d'image dans l'image s'inscrit au journal de la page, avec ce que la vidéo a
 * fait pendant que la page était cachée (la lecture en arrière-plan) ; « Send results » l'envoie dans
 * `startup.log` (`kind: "pip-test"`).
 */

type CaseId = "A" | "B" | "C";
const CASES: { id: CaseId; title: string; detail: string }[] = [
  { id: "A", title: "A · Plain MP4", detail: "<video src=\"…mp4\">" },
  { id: "B", title: "B · ManagedMediaSource", detail: "fMP4 appended to a ManagedMediaSource, disableRemotePlayback = true" },
  { id: "C", title: "C · Native HLS", detail: "<video src=\"…m3u8\">, fMP4 segments" },
];
const BASE = "/api/pip-test";
const MSE_TYPE = 'video/mp4; codecs="avc1.4D401E, mp4a.40.2"';

type PipVideo = HTMLVideoElement & {
  webkitSupportsPresentationMode?: (mode: string) => boolean;
  webkitSetPresentationMode?: (mode: string) => void;
  webkitPresentationMode?: string;
  webkitEnterFullscreen?: () => void;
};

interface LogLine {
  at: number;
  text: string;
}

function environment() {
  const nav = navigator as Navigator & { standalone?: boolean };
  return {
    displayModeStandalone: window.matchMedia("(display-mode: standalone)").matches,
    navigatorStandalone: nav.standalone === true,
    pictureInPictureEnabled: (document as Document & { pictureInPictureEnabled?: boolean }).pictureInPictureEnabled === true,
    managedMediaSource: "ManagedMediaSource" in window,
    mediaSource: "MediaSource" in window,
    userAgent: navigator.userAgent,
  };
}

function videoState(video: PipVideo | null): string {
  if (!video) return "—";
  const supports = typeof video.webkitSupportsPresentationMode === "function" ? String(video.webkitSupportsPresentationMode("picture-in-picture")) : "n/a";
  return [
    `t=${video.currentTime.toFixed(1)}s`,
    video.paused ? "paused" : "playing",
    `readyState=${video.readyState}`,
    `webkitSupportsPresentationMode(pip)=${supports}`,
    `presentationMode=${video.webkitPresentationMode ?? "n/a"}`,
    `disablePictureInPicture=${video.disablePictureInPicture}`,
  ].join(" · ");
}

export function PipTest() {
  const videos = useRef<Record<CaseId, PipVideo | null>>({ A: null, B: null, C: null });
  const hiddenAt = useRef<{ at: number; times: Partial<Record<CaseId, { t: number; playing: boolean }>> } | null>(null);
  const [log, setLog] = useState<LogLine[]>([]);
  const [env, setEnv] = useState<ReturnType<typeof environment> | null>(null);
  const [states, setStates] = useState<Record<CaseId, string>>({ A: "—", B: "—", C: "—" });
  const [sent, setSent] = useState<string | null>(null);

  const note = useCallback((text: string) => {
    setLog((lines) => [...lines.slice(-199), { at: Math.round(performance.now()), text }]);
  }, []);

  const refresh = useCallback(() => {
    setStates({ A: videoState(videos.current.A), B: videoState(videos.current.B), C: videoState(videos.current.C) });
  }, []);

  // L'environnement, une fois monté (il dépend de `window`), puis l'état des trois vidéos chaque seconde.
  useEffect(() => {
    const first = setTimeout(() => {
      const e = environment();
      setEnv(e);
      note(`page loaded · standalone=${e.displayModeStandalone || e.navigatorStandalone} · pictureInPictureEnabled=${e.pictureInPictureEnabled}`);
    }, 0);
    const timer = setInterval(refresh, 1000);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [note, refresh]);

  // La lecture en arrière-plan : ce que chaque vidéo a fait entre le moment où la page s'est cachée et son retour.
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === "hidden") {
        const times: Partial<Record<CaseId, { t: number; playing: boolean }>> = {};
        for (const { id } of CASES) {
          const v = videos.current[id];
          if (v) times[id] = { t: v.currentTime, playing: !v.paused };
        }
        hiddenAt.current = { at: performance.now(), times };
        note("page hidden");
        return;
      }
      const before = hiddenAt.current;
      hiddenAt.current = null;
      if (!before) return;
      const hiddenS = (performance.now() - before.at) / 1000;
      const parts = CASES.flatMap(({ id }) => {
        const was = before.times[id];
        const v = videos.current[id];
        if (!was || !v || !was.playing) return [];
        // Une mire de 60 s en boucle : une avance négative est un tour de boucle.
        let advanced = v.currentTime - was.t;
        if (advanced < 0) advanced += v.duration || 60;
        return [`${id} advanced ${advanced.toFixed(1)}s (${v.paused ? "now paused" : "still playing"})`];
      });
      note(`page visible again after ${hiddenS.toFixed(1)}s hidden${parts.length ? " · " + parts.join(" · ") : " · no video was playing"}`);
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [note]);

  // Les trois vidéos, montées une fois : leurs évènements au journal, puis leur source.
  const refA = useRef<HTMLVideoElement>(null);
  const refB = useRef<HTMLVideoElement>(null);
  const refC = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const elements: Record<CaseId, PipVideo | null> = { A: refA.current, B: refB.current, C: refC.current };
    const removers: (() => void)[] = [];
    for (const { id } of CASES) {
      const v = elements[id];
      videos.current[id] = v;
      if (!v) continue;
      for (const type of ["play", "pause", "ended", "error", "enterpictureinpicture", "leavepictureinpicture", "webkitpresentationmodechanged", "webkitbeginfullscreen", "webkitendfullscreen"]) {
        const listener = () => {
          const extra = type === "error" && v.error ? ` code=${v.error.code} ${v.error.message}` : type === "webkitpresentationmodechanged" ? ` → ${v.webkitPresentationMode}` : "";
          note(`${id} · ${type}${extra}`);
        };
        v.addEventListener(type, listener);
        removers.push(() => v.removeEventListener(type, listener));
      }
    }
    if (elements.A) elements.A.src = `${BASE}/pip.mp4`;
    if (elements.C) elements.C.src = `${BASE}/hls/index.m3u8`;
    if (elements.B) void openManaged(elements.B, note);
    return () => {
      for (const remove of removers) remove();
      for (const v of Object.values(elements)) {
        if (!v) continue;
        v.removeAttribute("src");
        (v as unknown as { srcObject: unknown }).srcObject = null;
        v.load();
      }
    };
  }, [note]);
  const refOf = { A: refA, B: refB, C: refC };

  const act = async (id: CaseId, action: "play" | "pip" | "webkit-pip" | "fullscreen") => {
    const v = videos.current[id];
    if (!v) return;
    try {
      if (action === "play") {
        await v.play();
        note(`${id} · play() resolved`);
      } else if (action === "pip") {
        if (typeof v.requestPictureInPicture !== "function") {
          note(`${id} · requestPictureInPicture is not available`);
          return;
        }
        await v.requestPictureInPicture();
        note(`${id} · requestPictureInPicture() resolved`);
      } else if (action === "webkit-pip") {
        if (typeof v.webkitSetPresentationMode !== "function") {
          note(`${id} · webkitSetPresentationMode is not available`);
          return;
        }
        v.webkitSetPresentationMode("picture-in-picture");
        note(`${id} · webkitSetPresentationMode("picture-in-picture") called → ${v.webkitPresentationMode}`);
      } else if (typeof v.webkitEnterFullscreen === "function") {
        v.webkitEnterFullscreen();
        note(`${id} · webkitEnterFullscreen() called`);
      } else {
        await v.requestFullscreen();
        note(`${id} · requestFullscreen() resolved`);
      }
    } catch (error) {
      note(`${id} · ${action} failed: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`);
    }
    refresh();
  };

  const send = async () => {
    try {
      const res = await fetch("/api/viewport-diag", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "pip-test", build: APP_BUILD, env, states, log: log.slice(-80).map((l) => `${l.at} ${l.text}`) }),
      });
      setSent(res.ok ? "Sent." : `Not sent (HTTP ${res.status}).`);
    } catch {
      setSent("Not sent (network).");
    }
  };

  return (
    <main className="mx-auto max-w-2xl px-4 py-6 text-sm text-white">
      <h1 className="text-xl font-semibold">Picture in Picture test</h1>
      <p className="mt-1 text-xs text-white/60">
        Synthetic test pattern (ffmpeg testsrc2 + 440 Hz tone), H.264 Main + AAC LC. Open this page in a Safari tab, then in
        the Home Screen web app, and compare.
      </p>

      <section className="mt-4 rounded-xl border border-white/15 p-3 font-mono text-[11px] leading-relaxed text-white/80">
        {env ? (
          <>
            <div>display-mode standalone: {String(env.displayModeStandalone)}</div>
            <div>navigator.standalone: {String(env.navigatorStandalone)}</div>
            <div>document.pictureInPictureEnabled: {String(env.pictureInPictureEnabled)}</div>
            <div>ManagedMediaSource: {String(env.managedMediaSource)} · MediaSource: {String(env.mediaSource)}</div>
            <div className="break-all">{env.userAgent}</div>
          </>
        ) : (
          "…"
        )}
      </section>

      {CASES.map(({ id, title, detail }) => (
        <section key={id} className="mt-5 rounded-xl border border-white/15 p-3">
          <h2 className="font-semibold">{title}</h2>
          <p className="text-xs text-white/60">{detail}</p>
          <video ref={refOf[id]} controls playsInline loop preload="metadata" className="mt-2 aspect-video w-full rounded-lg bg-black" />
          <div className="mt-2 flex flex-wrap gap-2">
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => void act(id, "play")}>Play</button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => void act(id, "pip")}>requestPictureInPicture()</button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => void act(id, "webkit-pip")}>webkitSetPresentationMode(pip)</button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => void act(id, "fullscreen")}>Fullscreen</button>
          </div>
          <p className="mt-2 break-words font-mono text-[11px] text-white/70">{states[id]}</p>
        </section>
      ))}

      <section className="mt-5 rounded-xl border border-white/15 p-3">
        <div className="flex items-center justify-between gap-2">
          <h2 className="font-semibold">Event log</h2>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => void send()}>Send results</button>
        </div>
        {sent && <p className="mt-1 text-xs text-white/60">{sent}</p>}
        <ol className="mt-2 space-y-0.5 font-mono text-[11px] text-white/80">
          {log.map((line, i) => (
            <li key={i}>
              {(line.at / 1000).toFixed(1)}s · {line.text}
            </li>
          ))}
        </ol>
      </section>
    </main>
  );
}

/** Le cas B : le fichier entier ajouté d'un coup à une ManagedMediaSource, ouverte comme `mseSource.ts` l'ouvre. */
async function openManaged(video: PipVideo, note: (text: string) => void): Promise<void> {
  const Managed = (window as unknown as { ManagedMediaSource?: typeof ManagedMediaSource }).ManagedMediaSource;
  const source: ManagedMediaSource | MediaSource = Managed ? new Managed() : new MediaSource();
  note(`B · using ${Managed ? "ManagedMediaSource" : "MediaSource"}`);
  // Comme notre lecteur : sans cela, Safari n'attache pas une source gérée (AirPlay ne peut pas la porter).
  video.disableRemotePlayback = true;
  const opened = new Promise<void>((resolve) => source.addEventListener("sourceopen", () => resolve(), { once: true }));
  try {
    (video as unknown as { srcObject: unknown }).srcObject = source;
  } catch {
    video.src = URL.createObjectURL(source as MediaSource);
  }
  if (!(video as unknown as { srcObject: unknown }).srcObject && !video.src) video.src = URL.createObjectURL(source as MediaSource);
  await opened;
  try {
    const bytes = await (await fetch(`${BASE}/pip.mp4`)).arrayBuffer();
    const buffer = source.addSourceBuffer(MSE_TYPE);
    await new Promise<void>((resolve, reject) => {
      buffer.addEventListener("updateend", () => resolve(), { once: true });
      buffer.addEventListener("error", () => reject(new Error("appendBuffer error")), { once: true });
      buffer.appendBuffer(bytes);
    });
    source.endOfStream();
    note(`B · ${(bytes.byteLength / 1e6).toFixed(1)} MB appended, endOfStream()`);
  } catch (error) {
    note(`B · setup failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
