/**
 * Les vues du son, et la liste des pistes que l'audio et les sous-titres partagent : la ligne
 * « Améliorer les dialogues » et sa vue. Des fonctions de rendu appelées à leur place dans
 * `PlayerSettingsMenu`, comme les autres vues.
 */

import { ChevronRight, Speech } from "lucide-react";
import type { DialogueMode } from "@/lib/webcodecs/dialogueEnhance";
import { DialogueBeta, MenuOption } from "@/components/playerControls/menuRows";
import { pickPrimary } from "@/components/playerControls/menuViewsDual";
import type { MenuViewContext } from "@/components/playerControls/PlayerSettingsMenu";

/** « Améliorer les dialogues » : les trois choix du sous-menu, avec les mots et dans l'ordre de
 *  l'Apple TV (Désactivé / Améliorer / Améliorer davantage — demande de Louis, 11/10/2026). */
const DIALOGUE_CHOICES: { mode: DialogueMode; label: string }[] = [
  { mode: "off", label: "player.dialogue.off" },
  { mode: "on", label: "player.dialogue.enhance" },
  { mode: "strong", label: "player.dialogue.further" },
];

/** Les pistes de la vue ouverte, audio ou sous-titres : une seule liste pour les deux. */
export function tracksView(v: MenuViewContext) {
  const { menu, setMenu, audioTracks, subtitleTracks, currentAudioId, currentSubtitleId, onChangeAudio, onChangeSubtitle, secondSubtitle } = v;
  return (menu === "audio" ? audioTracks : subtitleTracks).map((tr) => (
    <MenuOption
      key={tr.id}
      on={(menu === "audio" ? currentAudioId : currentSubtitleId) === tr.id}
      onClick={() => {
        if (menu === "audio") onChangeAudio(tr.id);
        // Le second pris comme principal : les deux s'échangent (§87).
        else if (secondSubtitle && tr.id === secondSubtitle.currentId) pickPrimary(v, tr.id);
        else onChangeSubtitle(tr.id);
        setMenu(null);
      }}
    >
      {/*
       * Deux lignes plutôt qu'une coupure.
       *
       * Les étiquettes de pistes sont courtes par construction — langue, format
       * remarquable, canaux — sauf lorsqu'une parenthèse doit distinguer deux pistes
       * que rien d'autre ne sépare : « Anglais — 5.1 (Mix 6-Tracks Original du
       * LaserDisc) ». C'est précisément le cas où couper efface ce qu'on avait mis là
       * pour choisir. Deux lignes suffisent à tout ce que la bibliothèque contient.
       */}
      <span className="min-w-0 line-clamp-2">
        {tr.label}
        {tr.detail && (
          <span data-track-detail className="ml-2 text-xs tabular-nums text-white/50">
            {tr.detail}
          </span>
        )}
      </span>
    </MenuOption>
  ));
}

/* Sous les pistes, comme sur l'Apple TV : c'est un réglage du son, il vivait dans le
   menu « … » jusqu'au 11/10/2026. Le nom seul et un chevron, comme l'apparence des
   sous-titres : l'état coupé en « … » sur un téléphone ne disait rien. */
export function dialogueRowView({ t, setMenu, dialogue }: MenuViewContext) {
  return (
    dialogue && (
      <div className="border-t border-white/10">
        <button
          data-dialogue-row
          onClick={() => setMenu("dialogue")}
          className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm text-white hover:bg-white/10"
        >
          <span className="flex min-w-0 items-center gap-2">
            <Speech size={16} className="shrink-0" />
            <span className="truncate">{t("player.dialogue.title")}</span>
            <DialogueBeta />
          </span>
          <ChevronRight size={14} className="shrink-0 text-white/50" />
        </button>
      </div>
    )
  );
}

export function dialogueView({ t, setMenu, dialogue }: MenuViewContext) {
  return (
    dialogue && (
      <>
        {DIALOGUE_CHOICES.map(({ mode, label }) => (
          <MenuOption
            key={mode}
            data-dialogue-choice={mode}
            on={dialogue.mode === mode}
            onClick={() => {
              if (mode !== dialogue.mode) dialogue.onChange(mode);
              setMenu(null);
            }}
          >
            {t(label)}
          </MenuOption>
        ))}
        {dialogue.mode !== "off" && !dialogue.applies && (
          <p data-dialogue-not-applied className="border-t border-white/10 px-3 pt-2 pb-2 text-xs text-white/60">
            {t("player.dialogue.notThisTrack")}
          </p>
        )}
      </>
    )
  );
}
