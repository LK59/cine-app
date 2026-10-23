"use client";

/**
 * Les écrans et les messages que le lecteur serveur pose sur sa vidéo : la piste à changer pendant
 * une diffusion, la diffusion interrompue, la pastille d'attente et les messages brefs de la version
 * allégée. L'hôte décide quand ; ils disent quoi.
 */
import type { ChromeEdges } from "@/lib/subtitleStyle";
import { useT } from "@/components/TranslationProvider";

/** La conséquence, dite avant le geste. Voir `requestAudioChange`. */
export function CastAudioWarning({ onCancel, onContinue }: { onCancel: () => void; onContinue: () => void }) {
  const t = useT();
  return (
    <div className="absolute inset-0 z-30 flex items-center justify-center bg-black/80 px-6 text-center">
      <div className="max-w-md">
        <p className="mb-4 text-sm text-white">{t("player.castAudioWarning")}</p>
        <div className="flex justify-center gap-3">
          <button
            type="button"
            onClick={onCancel}
            className="btn btn-ghost px-4 py-2"
          >
            {t("common.cancel")}
          </button>
          <button
            type="button"
            onClick={onContinue}
            className="btn-primary inline-flex justify-center"
          >
            {t("player.castAudioContinue")}
          </button>
        </div>
      </div>
    </div>
  );
}

export function CastInterruptedScreen({ onQuit, onRelaunch }: { onQuit: () => void; onRelaunch: () => void }) {
  const t = useT();
  return (
    <div className="absolute inset-0 z-30 flex items-center justify-center bg-black/80 px-6 text-center">
      <div>
        <p className="mb-4 text-sm text-white">{t("player.castInterrupted")}</p>
        <div className="flex justify-center gap-3">
          <button type="button" onClick={onQuit} className="btn btn-ghost px-4 py-2">
            {t("player.quit")}
          </button>
          <button type="button" onClick={onRelaunch} className="btn-primary inline-flex justify-center">
            {t("player.castRelaunch")}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Sous la roue d'attente, et non en bas de l'écran.
 *
 * Ces messages — « le chargement est toujours en cours », « reconnexion », « hors ligne » — étaient
 * collés au bord inférieur, c'est-à-dire exactement là où la barre de progression et les commandes
 * se posent : elles passaient par-dessus et le message devenait illisible au moment précis où il
 * sert. Signalé le 19/09/2026.
 *
 * Ils rejoignent donc la roue, qui est déjà au centre et dit la même chose sans les mots : un
 * demi-écran plus deux rems et demie, soit juste sous elle. Et un plan au-dessus des commandes,
 * pour que plus rien ne les recouvre.
 */
export function ServerWaitPill({
  isOffline,
  seekHint,
  compatPrep,
  loadingLong,
  hlsJs,
}: {
  isOffline: boolean;
  seekHint: boolean | undefined;
  compatPrep: boolean;
  loadingLong: boolean;
  hlsJs: boolean;
}) {
  const t = useT();
  return (
    <div
      className="pointer-events-none absolute inset-x-0 z-30 flex justify-center px-6"
      style={{ top: "calc(50% + 2.5rem)" }}
    >
      <div className="rounded-full bg-black/80 px-4 py-1.5 text-center text-xs text-white shadow-lg ring-1 ring-white/10">
        {isOffline
          ? t('player.offline')
          : seekHint
            ? t("player.slowLink.hint")
            : compatPrep
            ? t("player.compatPrep")
            : loadingLong
            ? t('player.stillLoading')
            : hlsJs
              ? t("player.slowLink.unstable")
              : t('player.reconnecting')}
      </div>
    </div>
  );
}

/**
 * Les messages brefs de la version allégée (§78), en bas à gauche, au-dessus des commandes, retirés
 * seuls : la bascule, et une génération de sous-titres qui ne suivra pas.
 */
export function LighterNotices({
  awaitingTap,
  switchNotice,
  subtitleGenNotice,
  chromeEdges,
}: {
  awaitingTap: boolean;
  switchNotice: boolean;
  subtitleGenNotice: boolean;
  chromeEdges: ChromeEdges | null;
}) {
  const t = useT();
  return (
    <div
      className="subtitle-lift pointer-events-none absolute z-40 flex max-w-[min(80vw,22rem)] flex-col gap-2"
      style={{
        left: "max(1rem, env(safe-area-inset-left))",
        bottom: "max(1rem, calc(env(safe-area-inset-bottom) + 0.75rem))",
        transform: chromeEdges?.bottom ? `translateY(-${Math.round(chromeEdges.bottom)}px)` : undefined,
      }}
      role="status"
    >
      {awaitingTap ? (
        <p data-lighter-tap-notice="" className="nav-glass animate-fade-in rounded-2xl px-3 py-2 text-xs leading-snug text-white">
          {t("player.slowLink.tapToResume")}
        </p>
      ) : (
        switchNotice && (
          <p data-lighter-switch-notice="" className="nav-glass animate-fade-in rounded-2xl px-3 py-2 text-xs leading-snug text-white">
            {t("player.slowLink.switched")}
          </p>
        )
      )}
      {subtitleGenNotice && (
        <p data-subtitle-gen-notice="" className="nav-glass animate-fade-in rounded-2xl px-3 py-2 text-xs leading-snug text-white">
          {t("player.slowLink.subtitlesGenerating")}
        </p>
      )}
    </div>
  );
}
