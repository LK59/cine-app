// Les voiles et les mots du lecteur natif (`ExperimentalPlayerHost.tsx`) — coupure réseau, connexion
// trop lente, erreur, avertissement passager, roue d'ouverture, rapport d'une attente bloquée, mot
// central —, sortis tels quels de son rendu le 23/10/2026. Les conditions d'affichage restent dans
// l'hôte ; ici, seulement ce qui est dessiné.
import { AlertTriangle, RotateCw, WifiOff } from "lucide-react";
import type { useT } from "@/components/TranslationProvider";
import { ExperimentalPlayerReport, type ReportInput } from "@/components/ExperimentalPlayerReport";
import { formatResumeClock } from "@/lib/playbackIntro";
import type { PlayerTrack } from "@/lib/webcodecs/playerTrack";

type T = ReturnType<typeof useT>;

export function NetworkLostScreen({
  t,
  online,
  networkLost,
  audioTracks,
  retryAfterNetwork,
  onClose,
}: {
  t: T;
  online: boolean;
  networkLost: { at: number; audio: number | null };
  audioTracks: PlayerTrack[];
  retryAfterNetwork: (at: number, why: string, byViewer?: boolean) => void;
  onClose: () => void;
}) {
  return (
    <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-4 bg-black/85 px-6 text-center">
      <WifiOff className={online ? "text-slate-500" : "text-amber-400"} size={32} />
      <div>
        <p className="text-base font-medium text-white">
          {online ? t("player.experimental.connectionBack") : t("player.experimental.connectionLost")}
        </p>
        <p className="mt-1 max-w-md text-sm leading-6 text-slate-400">
          {online ? t("player.experimental.connectionBackBody") : t("player.experimental.connectionLostBody")}
        </p>
      </div>
      <p className="text-xs text-slate-500">
        {t("player.experimental.resumeAt", { time: formatResumeClock(networkLost.at) })}
        {networkLost.audio !== null &&
          ` · ${audioTracks.find((a) => a.number === networkLost.audio)?.language ?? t("player.experimental.chosenTrack")}`}
      </p>
      <div className="mt-1 flex flex-wrap items-center justify-center gap-3">
        <button
          type="button"
          onClick={() => retryAfterNetwork(networkLost.at, "réessai demandé", true)}
          className="btn-primary inline-flex items-center gap-2"
        >
          <RotateCw size={16} />
          {t("player.experimental.retry")}
        </button>
        <button
          type="button"
          onClick={onClose}
          className="btn btn-ghost px-4 py-2"
        >
          {t("common.close")}
        </button>
      </div>
    </div>
  );
}

export function SlowLinkScreen({ t, onRetry, onClose }: { t: T; onRetry: () => void; onClose: () => void }) {
  return (
    <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-4 bg-black/85 px-6 text-center" data-slow-link-screen="">
      <WifiOff className="text-amber-400" size={32} />
      <p className="max-w-md text-base font-medium text-white">{t("player.slowLink.failed")}</p>
      <div className="mt-1 flex flex-wrap items-center justify-center gap-3">
        <button
          type="button"
          onClick={onRetry}
          className="btn-primary inline-flex items-center gap-2"
        >
          <RotateCw size={16} />
          {t("player.experimental.retry")}
        </button>
        <button type="button" onClick={onClose} className="btn btn-ghost px-4 py-2">
          {t("common.close")}
        </button>
      </div>
    </div>
  );
}

export function NativeErrorScreen({
  t,
  error,
  serverFallback,
  report,
  onSwitchToStable,
  onClose,
}: {
  t: T;
  error: string;
  serverFallback: boolean | undefined;
  report: ReportInput;
  onSwitchToStable: () => void;
  onClose: () => void;
}) {
  return (
    <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-4 bg-black/85 px-6 text-center">
      <AlertTriangle className="text-amber-400" size={32} />
      {/* Deux écrans, un seul gabarit. Là où un lecteur serveur existe, cet écran est une
          proposition — « celui-ci n'y arrive pas, l'autre peut-être » — et le titre dit
          lequel des deux a renoncé. Là où il n'en existe pas, c'est une fin de course : la
          phrase ne doit désigner aucun lecteur, puisqu'il n'y a pas de second à essayer, et
          le bouton qui y menait n'a plus de destination. */}
      <p className="text-base font-medium text-white">
        {serverFallback === false ? t("player.unplayable") : t("player.experimental.title")}
      </p>
      <p className="max-w-lg text-sm leading-6 text-slate-300">{error}</p>
      <ExperimentalPlayerReport input={report} />
      <div className="mt-2 flex flex-wrap items-center justify-center gap-3">
        {serverFallback !== false && (
          <button type="button" onClick={onSwitchToStable} className="btn-primary">
            {t("player.experimental.switchToStable")}
          </button>
        )}
        <button
          type="button"
          onClick={onClose}
          className={serverFallback === false ? "btn-primary" : "btn btn-ghost px-4 py-2"}
        >
          {t("common.close")}
        </button>
      </div>
    </div>
  );
}

export function NativeWarning({ text }: { text: string }) {
  return (
    <div className="pointer-events-none absolute inset-x-0 top-16 z-10 flex justify-center">
      <span className="rounded-full bg-amber-500/15 px-3 py-1.5 text-xs text-amber-200 ring-1 ring-amber-400/30">
        {text}
      </span>
    </div>
  );
}

export function OpeningSpinner({ waitingWord }: { waitingWord: string | null }) {
  return (
    <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
      <div className="flex flex-col items-center gap-3">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-white/20 border-t-white" />
        {/* Silent while the wait is too short to read. A sentence that appears and goes before
            it can be finished is noise, not company. */}
        {waitingWord && <p className="text-sm text-slate-400">{waitingWord}</p>}
      </div>
    </div>
  );
}

export function StuckReport({ report }: { report: ReportInput }) {
  return (
    <div className="absolute inset-x-0 bottom-0 z-20 flex justify-center bg-gradient-to-t from-black/95 to-transparent px-6 pb-6 pt-16">
      <ExperimentalPlayerReport input={report} />
    </div>
  );
}

export function CenterWord({ word }: { word: string }) {
  return (
    <div className="pointer-events-none absolute inset-x-0 top-1/2 mt-10 flex justify-center">
      <p className="text-sm text-slate-400">{word}</p>
    </div>
  );
}
