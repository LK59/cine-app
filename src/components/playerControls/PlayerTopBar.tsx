"use client";

/**
 * La rangée du haut du lecteur : fermer, la pilule de la diffusion et du mini-lecteur (avec sa
 * confirmation « Passer sur AirPlay »), et le son. Sortie de `PlayerControls` telle quelle.
 */

import { useEffect, useRef, useState, type RefObject } from "react";
import { X, Cast, ChevronDown, PictureInPicture2, Volume2, VolumeX } from "lucide-react";
import { useT } from "@/components/TranslationProvider";

/** Combien de temps la confirmation de diffusion reste dépliée sans qu'on y touche. */
const CAST_CONFIRM_MS = 4000;

export function PlayerTopBar({
  rowRef,
  visible,
  showControls,
  onClose,
  onMinimize,
  pip,
  chromecast,
  castSupported,
  castKind,
  castActive,
  onCastRequest,
  showCastPicker,
  muted,
  volume,
  volumeSettable,
  toggleMute,
  changeVolume,
}: {
  rowRef: RefObject<HTMLDivElement | null>;
  visible: boolean;
  showControls: (delayMs?: number) => void;
  onClose: () => void;
  onMinimize: () => void;
  /** L'image dans l'image du système — voir `useSystemPip`. Absente, pas de bouton. */
  pip?: { supported: boolean; active: boolean; toggle: () => void };
  chromecast?: { active: boolean; onRequest: () => void };
  castSupported: boolean;
  castKind: "airplay" | "remote";
  castActive?: boolean;
  onCastRequest?: () => void;
  showCastPicker: () => Promise<void>;
  muted: boolean;
  volume: number;
  volumeSettable: boolean;
  toggleMute: () => void;
  changeVolume: (value: number) => void;
}) {
  const t = useT();
  /**
   * La pilule de diffusion dépliée en « Passer sur AirPlay · Confirmer » — lecteur natif seulement.
   *
   * Passer sur AirPlay quitte le lecteur natif pour le lecteur serveur : un geste qui coûte une
   * nouvelle ouverture, et le bouton est voisin de celui du mini-lecteur, sous le même pouce. Le
   * premier appui demande, le second fait. Le lecteur serveur, lui, ouvre le sélecteur du système
   * au premier appui : il n'y a rien à quitter.
   */
  const [castConfirm, setCastConfirm] = useState(false);
  const castPillRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!castConfirm) return;
    // Repliée d'elle-même au bout de quatre secondes, ou par un appui ailleurs.
    const timer = setTimeout(() => setCastConfirm(false), CAST_CONFIRM_MS);
    const onPointerDown = (e: PointerEvent) => {
      if (!castPillRef.current?.contains(e.target as Node)) setCastConfirm(false);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("pointerdown", onPointerDown, true);
    };
  }, [castConfirm]);

  /* En haut : fermer, puis — à distance, pour que le pouce ne prenne pas l'un pour l'autre — la
     pilule de la diffusion et du mini-lecteur ; à droite, le son seul. Le reste est en bas,
     près de la barre, comme sur l'Apple TV. Marges : 16, 24 puis 32 px, plus les bords sûrs
     (encoche en paysage, Dynamic Island en portrait). */
  return (
    <div
      data-player-navgroup="topbar"
      ref={rowRef}
      className={`player-chrome-x ${visible ? "pointer-events-auto translate-y-0" : "pointer-events-none -translate-y-1"} player-spring flex items-center justify-between gap-3 pb-4 motion-reduce:translate-y-0`}
      // Capture phase: children stopPropagation() in the bubble phase, which is exactly why
      // the old timer never got reset by button use — capture fires on the way DOWN, before
      // any child handler, so every top-bar interaction reliably re-arms the long timer.
      onClickCapture={() => showControls(10000)}
      style={{ paddingTop: "max(1rem, calc(env(safe-area-inset-top) + 1rem))" }}
    >
      <div className="flex min-w-0 items-center gap-4 max-[379px]:gap-3">
        <button
          data-player-nav="close"
          onClick={(e) => {
            e.stopPropagation();
            onClose();
          }}
          aria-label={t("common.close")}
          data-liquid
          className="player-fade player-pill player-pill-btn player-pill-solo shrink-0"
        >
          <X size={24} />
        </button>
        <div ref={castPillRef} data-cast-pill data-liquid className="player-fade player-pill flex min-w-0 items-center p-1">
          {/* Les deux boutons au repos, et la confirmation qui prend leur place : deux segments
              toujours là, l'un se resserrant pendant que l'autre s'ouvre — la pilule grandit
              d'un geste au lieu de sauter d'une largeur à l'autre. */}
          <div
            className={`player-pill-seg flex items-center gap-1 ${castConfirm ? "player-pill-seg-closed" : ""}`}
            inert={castConfirm}
            aria-hidden={castConfirm || undefined}
          >
            {chromecast && (
              <button
                data-player-nav="chromecast"
                onClick={(e) => {
                  e.stopPropagation();
                  // Dans le geste même : la liste des récepteurs de Chrome ne s'ouvre qu'ainsi.
                  chromecast.onRequest();
                }}
                aria-label={t("player.chromecast.button")}
                title={t("player.chromecast.button")}
                data-active={chromecast.active ? "" : undefined}
                className="player-pill-btn"
              >
                <Cast size={22} />
              </button>
            )}
            {/* Le bouton de diffusion du navigateur (Remote Playback) se tait quand celui du
                Chromecast est là : deux icônes identiques pour deux chemins, l'un des deux ne
                menant nulle part sur un flux MediaSource. AirPlay n'est jamais concerné — il
                n'existe pas là où le Chromecast se propose. */}
            {castSupported && !(chromecast && castKind === "remote") && (
              <button
                data-player-nav="cast"
                onClick={(e) => {
                  e.stopPropagation();
                  // Le lecteur serveur joue une adresse : le sélecteur s'ouvre tout de suite, dans
                  // ce geste même — `showCastPicker` l'appelle avant tout `await`, ce qu'iOS exige.
                  // Le lecteur natif doit d'abord céder la place (`onCastRequest`) : on demande.
                  if (onCastRequest) setCastConfirm(true);
                  else void showCastPicker();
                }}
                aria-label={t("player.cast")}
                data-active={castActive ? "" : undefined}
                className="player-pill-btn"
              >
                <Cast size={22} />
              </button>
            )}
            {/* L'image dans l'image du système porte l'icône que tout le monde lui connaît ;
                « Réduire » (le mini-lecteur de l'app) a pris le chevron le 28/10/2026 — deux
                icônes identiques pour deux gestes différents se seraient lues comme un seul. */}
            {pip?.supported && (
              <button
                data-player-nav="pip"
                onClick={(e) => {
                  e.stopPropagation();
                  // Dans le geste même : le système refuse une demande qui n'en vient pas.
                  pip.toggle();
                }}
                title={t("player.pip")}
                aria-label={t("player.pip")}
                aria-pressed={pip.active}
                data-active={pip.active ? "" : undefined}
                className="player-pill-btn"
              >
                <PictureInPicture2 size={22} />
              </button>
            )}
            {/* Masqué pendant l'image dans l'image du système : déplacer la vidéo dans le
                mini-lecteur l'en ferait sortir. */}
            {!pip?.active && (
              <button
                data-player-nav="minimize"
                onClick={(e) => {
                  e.stopPropagation();
                  onMinimize();
                }}
                title={t('player.minimize')}
                aria-label={t('player.minimize')}
                className="player-pill-btn"
              >
                <ChevronDown size={24} />
              </button>
            )}
          </div>
          <div
            data-cast-confirm={castConfirm ? "open" : "closed"}
            className={`player-pill-seg flex min-w-0 items-center gap-2 ${castConfirm ? "" : "player-pill-seg-closed"}`}
            inert={!castConfirm}
            aria-hidden={!castConfirm || undefined}
          >
            <span className="min-w-0 truncate pl-3 text-sm text-white/90 max-[379px]:text-[13px]">
              {t(castKind === "airplay" ? "player.castConfirm.airplay" : "player.castConfirm.remote")}
            </span>
            <button
              data-player-nav="cast-confirm"
              onClick={(e) => {
                e.stopPropagation();
                setCastConfirm(false);
                // Exactement le chemin d'avant : le lecteur natif cède la place au lecteur
                // serveur, qui ouvre le sélecteur quand son élément est prêt.
                onCastRequest?.();
              }}
              className="player-capsule shrink-0"
            >
              {t("player.castConfirm.confirm")}
            </button>
          </div>
        </div>
      </div>
      {/* Le son, seul à droite. Au bureau, le curseur se replie et se déplie sous le pointeur ou
          au clavier (`.player-volume`, globals.css) — à gauche du bouton, qui reste sous le
          pointeur (LECTEUR-13, 15/10/2026) ; partout ailleurs — doigt, tablette, écran
          tactile — il reste déplié, et sur iPhone il n'y a que le bouton, iOS ignorant le
          volume d'une page. Jamais une fonction réservée au survol. Le temps d'une confirmation
          de diffusion, sur un écran étroit, il cède sa place à la pilule qui s'ouvre. */}
      <div data-liquid className={`player-fade player-volume player-pill flex shrink-0 items-center p-1 ${castConfirm ? "max-sm:hidden" : ""}`}>
        <button
          data-player-nav="mute"
          onClick={(e) => {
            e.stopPropagation();
            toggleMute();
          }}
          aria-label={t("player.mute")}
          className="player-pill-btn"
        >
          {/* Les deux icônes toujours là, l'une qui part pendant que l'autre arrive (`player-swap`). */}
          <span className="player-swap" aria-hidden>
            <span data-off={muted || volume === 0 ? "" : undefined}><Volume2 size={22} /></span>
            <span data-off={muted || volume === 0 ? undefined : ""}><VolumeX size={22} /></span>
          </span>
        </button>
        {/* Four pixels tall is a target a finger cannot land on, let alone drag along: every
            touch became a tap, and a tap on a range input jumps straight to the end it
            landed nearest. Twenty is the same bar with room to hold on to. */}
        {volumeSettable && (
          <span className="player-volume-slider flex items-center">
            <input
              data-player-nav="volume"
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={muted ? 0 : volume}
              onChange={(e) => changeVolume(Number(e.target.value))}
              onClick={(e) => e.stopPropagation()}
              aria-label={t("player.volume")}
              className="mr-3 h-5 w-20 cursor-pointer accent-white"
              style={{ WebkitTouchCallout: "none", touchAction: "none" }}
            />
          </span>
        )}
      </div>
    </div>
  );
}
