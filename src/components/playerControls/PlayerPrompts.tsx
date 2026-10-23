"use client";

/**
 * Les invites flottantes du lecteur, visibles même commandes masquées : « Passer l'intro / le
 * récap », la ligne de la minuterie de veille, « Vous êtes toujours là ? » et la carte de l'épisode
 * suivant. Ce qui décide de les montrer reste dans `PlayerControls` ; elles ne font que s'afficher.
 */

import { X, Moon } from "lucide-react";
import { useT } from "@/components/TranslationProvider";
import { noteViewerPresent } from "@/lib/autoAdvance";
import { sleepTimerStore } from "@/lib/sleepTimer";
import type { ActiveSkip } from "@/lib/playerSkip";
import { PROMPT_BOTTOM } from "@/components/playerControls/layout";

export function PlayerPrompts({
  skipNow,
  onSkip,
  sleepWarning,
  askStillThere,
  showNextUp,
  nextEpisode,
  nextUpCountdown,
  requestAdvance,
  onDismissNextUp,
}: {
  skipNow: ActiveSkip | null;
  onSkip: (end: number) => void;
  sleepWarning: number | null;
  askStillThere: boolean;
  showNextUp: boolean;
  nextEpisode: { itemId: string; title: string } | null;
  nextUpCountdown: number;
  requestAdvance: () => boolean;
  onDismissNextUp: () => void;
}) {
  const t = useT();
  return (
    <>
      {/* Skip-intro and next-up prompts stay visible even when the rest of the
          controls have auto-hidden — they're time-sensitive, not navigation. */}
      {skipNow && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onSkip(skipNow.end);
          }}
          data-liquid
          className="player-pill pointer-events-auto absolute px-4 py-2.5 text-sm font-medium text-white"
          style={{
            bottom: PROMPT_BOTTOM,
            right: "max(1rem, env(safe-area-inset-right))",
          }}
        >
          {skipNow.kind === "recap" ? t("player.skipRecap") : t("player.skipIntro")}
        </button>
      )}

      {/* Les trente dernières secondes de la minuterie de veille : une ligne, à la place de rien.
          Visible commandes masquées — c'est précisément quand personne ne les regarde qu'elle sert. */}
      {sleepWarning !== null && (
        <div
          data-player-surface-ignore
          onClick={(e) => e.stopPropagation()}
          className="player-pill pointer-events-auto absolute flex items-center gap-2 py-1.5 pl-3.5 pr-1.5 text-xs text-white/80"
          style={{
            bottom: PROMPT_BOTTOM,
            left: "max(1rem, env(safe-area-inset-left))",
          }}
        >
          <Moon size={12} aria-hidden />
          <span className="tabular-nums">{t("player.sleep.warning", { n: sleepWarning })}</span>
          <span aria-hidden>·</span>
          <button
            type="button"
            onClick={() => {
              noteViewerPresent();
              sleepTimerStore.continue();
            }}
            className="rounded-full px-2 py-0.5 font-medium text-white hover:bg-white/10"
          >
            {t("player.sleep.continue")}
          </button>
        </div>
      )}

      {/* La question, à la place de l'épisode suivant. Elle occupe tout l'écran plutôt qu'un coin :
          si personne n'est là, autant que la pièce cesse d'être éclairée par un film qui joue. */}
      {askStillThere && nextEpisode && (
        <div
          // Un clic sur son fond n'est pas un clic sur l'image : il ne met rien en pause derrière.
          data-player-surface-ignore
          className="pointer-events-auto absolute inset-0 z-20 flex flex-col items-center justify-center gap-5 bg-black/80 px-6 text-center">
          <p className="text-lg font-medium text-white">{t("player.stillThere")}</p>
          <p className="max-w-sm text-sm text-slate-400">{t("player.stillThereHint")}</p>
          <button
            type="button"
            onClick={() => {
              noteViewerPresent();
              requestAdvance();
            }}
            className="btn-primary px-6"
          >
            {t("player.stillThereContinue")}
          </button>
        </div>
      )}

      {showNextUp && !askStillThere && nextEpisode && (
        <div
          // Ses boutons ne doivent pas atteindre le fond, dont l'appui montre ou cache les commandes —
          // ni son double-clic le plein écran (`data-player-surface-ignore`, 11/10/2026).
          data-player-surface-ignore
          onClick={(e) => e.stopPropagation()}
          // Le verre des pilules, et une entrée qui rebondit (`glass-pop`) : une carte opaque à part
          // était la dernière surface du lecteur à ne pas en être (04/10/2026).
          className="nav-glass glass-pop pointer-events-auto absolute w-72 max-w-[calc(100vw-2rem)] rounded-[22px] p-4"
          style={{
            bottom: PROMPT_BOTTOM,
            right: "max(1rem, env(safe-area-inset-right))",
          }}
        >
          <p className="mb-1 text-xs text-slate-400">{t('player.nextEpisodeIn', { n: nextUpCountdown })}</p>
          <p className="mb-3 truncate text-sm font-medium text-white">{nextEpisode.title}</p>
          <div className="flex gap-2">
            <button
              onClick={() => {
                noteViewerPresent();
                requestAdvance();
              }}
              className="btn-primary flex-1 justify-center py-1.5 text-xs"
            >
              {t('player.playNow')}
            </button>
            <button
              onClick={onDismissNextUp}
              // Une icône seule : sans nom, un lecteur d'écran n'annonçait que « bouton » (13/10/2026).
              aria-label={t("common.close")}
              className="rounded-lg bg-white/10 px-3 py-1.5 text-xs text-white hover:bg-white/20"
            >
              <X size={14} />
            </button>
          </div>
        </div>
      )}
    </>
  );
}
