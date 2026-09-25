"use client";

import { PlayCircle, RotateCcw } from "lucide-react";
import { formatResumeTicks } from "@/lib/format";
import { useT } from "@/components/TranslationProvider";
import { usePlayerEnabledState } from "@/lib/usePlayerEnabled";
import { usePlayback } from "@/components/PlaybackProvider";
import { resumeAtFor } from "@/lib/resumePosition";

interface PlayButtonProps {
  itemId: string;
  title: string;
  /** UserData.PlaybackPositionTicks — omit or 0 for "Lire", any positive value shows "Reprendre - Xmin". */
  resumeTicks?: number;
  /** RunTimeTicks — combined with resumeTicks to draw the in-button progress fill (variant="primary" only). */
  runtimeTicks?: number;
  className?: string;
  iconSize?: number;
  /** "primary": solid button, progress fill inside when resuming (movie/series sheets) ·
   *  "pill": small rounded button with label (cards, lists) · "icon": icon-only, no label ·
   *  "row": full-width menu row with a circular icon badge (Cinema Mode's detail overlay). */
  variant?: "primary" | "pill" | "icon" | "row";
  /** Overrides the default Lire/Reprendre text — for the series-level button,
   *  which needs episode context, e.g. "Reprendre EP3 S2 - 23min05". */
  label?: string;
  /** For series: resolves the episode after the given itemId, if any — powers
   *  the credits-time "next up" prompt and its in-place auto-advance. */
  getNextEpisode?: (currentItemId: string) => { itemId: string; title: string } | null;
  /**
   * Repartir du début plutôt que de reprendre.
   *
   * Rendu par ce composant et non par un bouton à part, pour la même raison que le reste : la
   * position de reprise, l'accès au lecteur et le comportement du clic sont décidés ici une
   * fois. Le bouton ne s'affiche que là où il a un sens — c'est-à-dire quand il y a bien une
   * reprise à écarter.
   */
  restart?: boolean;
  /**
   * Sait-on seulement s'il y a une reprise ?
   *
   * `resumeTicks` ne peut pas répondre : absent, il dit aussi bien « ce film n'a jamais été
   * commencé » que « la réponse n'est pas encore arrivée ». Les deux menaient au même geste, et
   * le second est un mensonge — sur une page fraîchement chargée, on clique avant que
   * `/api/cinema/progress/…` ait répondu, et le film repartait du début alors qu'il était vu à
   * moitié.
   *
   * Faux, on ne prétend rien : la position est laissée absente, ce qui veut dire « je ne sais
   * pas, prends ce dont le serveur se souvient » — voir PlaybackSession. C'est la même règle que
   * les bascules « vu » et « favori », qui attendent de savoir avant de laisser agir.
   *
   * Vrai par défaut : les appelants qui rendent une rangée tiennent déjà la donnée dans la main.
   */
  resumeKnown?: boolean;
  /**
   * Jellyfin a répondu que le fichier n'existe plus (`useFileMissing`) : le bouton reste à sa
   * place, grisé, sans rien lancer. Seulement ce cas-là — une coupure ou un retard ne grise
   * jamais un titre lisible (voir `missingFiles.ts`).
   */
  unavailable?: boolean;
  /**
   * Garder la place du bouton tant qu'on ne sait pas si la lecture est ouverte, au lieu de ne
   * rien rendre puis de le voir surgir en poussant la fiche (25/09/2026). Pour les fiches, dont
   * le bouton est l'action principale ; une carte ou une rangée n'a pas de place à tenir.
   */
  reserve?: boolean;
}

// Single source of truth for the Lire/Reprendre label + resume behavior, used
// everywhere a play button appears (movie sheets, episode rows, dashboard,
// recent-activity cards) so wording and behavior never drift between pages.
export function PlayButton({
  itemId,
  title,
  resumeTicks,
  runtimeTicks,
  className,
  iconSize = 14,
  variant = "pill",
  label: labelOverride,
  getNextEpisode,
  restart = false,
  resumeKnown = true,
  unavailable = false,
  reserve = false,
}: PlayButtonProps) {
  const playback = usePlayback();
  const t = useT();
  const playerEnabled = usePlayerEnabledState();

  // `undefined` : on ne sait pas encore. Une fiche garde la place — le même bouton, invisible et
  // inerte, donc exactement de la même taille ; le reste ne rend rien, comme avant.
  const pending = playerEnabled === undefined && reserve && !restart;
  if (!playerEnabled && !pending) return null;
  const inert = pending || unavailable;

  const hasResume = !!resumeTicks && resumeTicks > 0;
  // Un bouton « recommencer » sans reprise en cours ne recommencerait rien — ni sur un fichier
  // qui n'existe plus.
  if (restart && (!hasResume || unavailable)) return null;

  const label = unavailable ? t('cinema.fileMissing') : labelOverride ?? (
    restart ? t('common.restart') : hasResume ? `${t('common.resume')} - ${formatResumeTicks(resumeTicks!)}` : t('common.play')
  );
  // Un nombre dès qu'on sait, et rien du tout quand on ne sait pas. Zéro veut dire « depuis le
  // début » et ne doit être dit que par quelqu'un qui en est sûr — voir `resumeKnown`.
  const initialResumeAt = resumeAtFor({ fromStart: restart, known: resumeKnown, resumeTicks });
  const progressPct =
    !restart && !unavailable && hasResume && runtimeTicks && runtimeTicks > 0 ? Math.min(100, (resumeTicks! / runtimeTicks) * 100) : null;
  const Icon = restart ? RotateCcw : PlayCircle;

  const defaultClass =
    variant === "icon"
      ? "rounded-full bg-accent-600/80 p-1.5 text-white hover:bg-accent-600"
      : variant === "primary"
        ? "btn-primary relative overflow-hidden"
        : variant === "row"
          ? "flex w-full items-center gap-3 rounded-lg px-4 py-2.5 text-left text-white transition-colors hover:bg-white/10 focus-visible:bg-white/10 focus-visible:outline-none"
          /* Sans flou d'arrière-plan, et c'est la même leçon que `.btn` a déjà apprise : il se
             recalcule par élément et par image, et cette pastille est celle des cartes — il y en a
             des rangées entières à l'écran pendant qu'on fait défiler. Ce qu'il apportait, un fond
             qui tient sur n'importe quelle affiche, l'opacité le donne déjà. */
          : "flex items-center gap-1.5 rounded-lg bg-accent-600/85 px-3 py-1.5 text-xs text-white hover:bg-accent-600";

  return (
    <button
      // Une ligne inerte n'entre pas dans la navigation au clavier du menu de la fiche.
      data-detail-menu={variant === "row" && !inert ? "" : undefined}
      data-play-reserved={pending ? "" : undefined}
      data-play-unavailable={unavailable ? "" : undefined}
      disabled={inert}
      aria-hidden={pending || undefined}
      tabIndex={pending ? -1 : undefined}
      onClick={(e) => {
        e.stopPropagation();
        e.preventDefault();
        if (inert) return;
        playback.play({ itemId, title, resumeAt: initialResumeAt, getNextEpisode });
      }}
      className={`${className ?? defaultClass}${pending ? " invisible" : unavailable ? " cursor-not-allowed opacity-45" : ""}`}
      title={label}
    >
      {variant === "primary" && progressPct !== null && (
        <span className="absolute inset-y-0 left-0 bg-white/25" style={{ width: `${progressPct}%` }} />
      )}
      {/* Où l'on en est, dans le bouton qui reprend — et nulle part ailleurs.
          Une barre posée au-dessus, dans la colonne, flottait entre le titre et le synopsis sans
          se rattacher à rien. Ici elle épouse le bas de la ligne : lisible sur le fond sombre du
          repos comme sous le sélecteur blanc, puisqu'elle porte sa propre couleur. */}
      {variant === "row" && progressPct !== null && (
        <span className="absolute inset-x-0 bottom-0 h-[3px] overflow-hidden rounded-b-lg bg-current/15">
          <span className="block h-full bg-accent-500" style={{ width: `${progressPct}%` }} />
        </span>
      )}
      {variant === "row" ? (
        <>
          {/* `bg-current/15` et non `bg-white/10` : la pastille se teinte de la couleur du texte de la
              ligne, donc elle reste visible aussi bien sur une ligne sombre que sur la ligne
              blanche de l'action principale, sans que l'appelant ait à s'en occuper. */}
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-current/15 [@media(min-height:820px)]:h-8 [@media(min-height:820px)]:w-8">
            <Icon size={iconSize} />
          </span>
          <span className="text-sm font-medium">{label}</span>
        </>
      ) : (
        <span className="relative z-10 inline-flex items-center gap-1.5">
          <Icon size={iconSize} />
          {variant !== "icon" && label}
        </span>
      )}
    </button>
  );
}
