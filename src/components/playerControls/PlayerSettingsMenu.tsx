"use client";

/**
 * Les menus du lecteur, nés de la pilule des réglages : les vues (audio, sous-titres, « … » et leurs
 * sous-vues), leur titre, leur « Retour », et les lignes de choix qu'elles partagent. Sortis de
 * `PlayerControls` tels quels ; l'état du menu ouvert reste chez lui, qui le referme aussi.
 */

import type { RefObject } from "react";
import { Captions, AudioLines, Gauge, ListVideo, EllipsisVertical, ArrowLeft, Sun, Timer, ChevronRight, Languages, Layers } from "lucide-react";
import type { DialogueMode } from "@/lib/webcodecs/dialogueEnhance";
import type { HdrCapChoice } from "@/lib/webcodecs/hdrDisplay";
import { useT } from "@/components/TranslationProvider";
import { LiquidMenu } from "@/components/player/LiquidMenu";
import { subtitleStyleStore, SUBTITLE_SIZES, SUBTITLE_COLORS, SUBTITLE_BACKGROUNDS, type SubtitleStyle } from "@/lib/subtitleStyle";
import type { PlaybackQuality } from "@/lib/playbackQuality";
import type { SleepMode } from "@/lib/sleepTimer";
import type { TrickplayInfo } from "@/lib/trickplayTile";
import type { PlayerItemPayload } from "@/app/api/player/item/[itemId]/route";
import type { SecondSubtitleMenu, SubtitleGenerationMenu, Track } from "@/components/PlayerControls";
import { BOTTOM_EDGE } from "@/components/playerControls/layout";
import { MenuOption, OffsetRow, SubtitleStyleGroup } from "@/components/playerControls/menuRows";
import { dialogueRowView, dialogueView, tracksView } from "@/components/playerControls/menuViewsAudio";
import { dualPrimaryView, dualRowView, dualSecondView, dualView } from "@/components/playerControls/menuViewsDual";
import { chaptersView, episodesView, hdrCapHintView, hdrCapView, moreView, qualityView, sleepView, speedView } from "@/components/playerControls/menuViewsMore";

/** Les vues des menus du lecteur. */
export type MenuView =
  | "audio"
  | "subtitles"
  | "speed"
  | "chapters"
  | "subtitleStyle"
  | "hdrCap"
  | "sleep"
  | "dialogue"
  | "subtitleGen"
  | "subtitleGenOther"
  | "dual"
  | "dualPrimary"
  | "dualSecond"
  | "quality"
  | "episodes"
  | "more";
/**
 * La vue d'où l'on vient, pour celles qui ont un « Retour » — et seulement elles : une vue absente
 * d'ici (audio, sous-titres, « … », épisodes) est une racine, ouverte par un bouton de la barre.
 */
const MENU_PARENT: Partial<Record<MenuView, MenuView>> = {
  subtitleStyle: "subtitles",
  subtitleGen: "subtitles",
  dual: "subtitles",
  subtitleGenOther: "subtitleGen",
  dualPrimary: "dual",
  dualSecond: "dual",
  dialogue: "audio",
  chapters: "more",
  hdrCap: "more",
  sleep: "more",
  speed: "more",
  quality: "more",
};
/** Le titre de chaque vue des menus, et son icône — celle du bouton qui l'ouvre. */
const MENU_TITLES: Record<string, string> = {
  speed: "player.speed",
  audio: "player.audio",
  subtitles: "player.subtitles",
  subtitleStyle: "player.subtitleStyle.title",
  subtitleGen: "player.subtitleGen.generate",
  subtitleGenOther: "player.subtitleGen.generate",
  dual: "player.dualSubtitles.title",
  dualPrimary: "player.dualSubtitles.primary",
  dualSecond: "player.dualSubtitles.second",
  more: "player.moreOptions",
  episodes: "player.episodes.title",
  chapters: "player.chapters",
  sleep: "player.sleep.title",
  hdrCap: "player.hdrCap.title",
  // Le libellé de la ligne qui ouvre la vue : sans lui, ces deux vues étaient les seules sans
  // titre, et rien au-dessus des choix ne disait ce qu'ils réglaient (audit du 22/10/2026).
  dialogue: "player.dialogue.title",
  quality: "player.quality.title",
};
const MENU_ICONS: Record<string, React.ReactNode> = {
  speed: <Gauge size={20} />,
  audio: <AudioLines size={20} />,
  subtitles: <Captions size={20} />,
  subtitleStyle: <Captions size={20} />,
  subtitleGen: <Languages size={20} />,
  subtitleGenOther: <Languages size={20} />,
  dual: <Captions size={20} />,
  dualPrimary: <Captions size={20} />,
  dualSecond: <Captions size={20} />,
  more: <EllipsisVertical size={20} />,
  episodes: <Layers size={20} />,
  chapters: <ListVideo size={20} />,
  sleep: <Timer size={20} />,
  hdrCap: <Sun size={20} />,
};

/** Ce que `PlayerControls` donne au menu. */
export type SettingsMenuProps = {
  menu: MenuView;
  setMenu: (view: MenuView | null) => void;
  menuRef: RefObject<HTMLDivElement | null>;
  anchorRef: RefObject<HTMLDivElement | null>;
  showControls: (delayMs?: number) => void;
  itemId: string;
  playerItem: PlayerItemPayload | null;
  downloadable: boolean;
  audioTracks: Track[];
  currentAudioId: number | null;
  onChangeAudio: (id: number) => void;
  subtitleTracks: Track[];
  currentSubtitleId: number | null;
  onChangeSubtitle: (id: number | null) => void;
  subtitleOffset: number;
  shiftSubtitles: (deltaSeconds: number) => void;
  secondSubtitle?: SecondSubtitleMenu;
  secondId: number | null;
  secondOffset: number;
  shiftSecond: (deltaSeconds: number) => void;
  subtitleGeneration?: SubtitleGenerationMenu;
  subtitleStyle: SubtitleStyle;
  dialogue?: { mode: DialogueMode; applies: boolean; onChange: (mode: DialogueMode) => void };
  hdrCap?: { current: HdrCapChoice; autoNits: number | null; onPick: (choice: HdrCapChoice) => void };
  frameFit?: { on: boolean; onChange: (on: boolean) => void };
  quality: PlaybackQuality;
  speed: number;
  changeSpeed: (rate: number) => void;
  sleepMode: SleepMode;
  sleepMinutes: number | null;
  nextEpisode: { itemId: string; title: string } | null;
  onCastReturn?: () => void;
  castActive?: boolean;
  castSupported: boolean;
  chromecast?: { active: boolean; onRequest: () => void };
  onTogglePlaybackInfo: () => void;
  episodesSeriesId: string | null;
  onPlayEpisode?: (episode: { itemId: string; title: string; resumeAt: number }) => void;
  chapters: { start: number; name: string | null }[];
  jumpToChapter: (startSeconds: number) => void;
  currentTime: number;
  trickplay: TrickplayInfo | null;
  trickplayTileAt: (time: number) => { url: string; bgX: number; bgY: number } | null;
};
/** Ce que reçoit chaque vue : les props du menu et la traduction. */
export type MenuViewContext = SettingsMenuProps & { t: ReturnType<typeof useT> };

export function PlayerSettingsMenu(props: SettingsMenuProps) {
  const {
    menu,
    setMenu,
    menuRef,
    anchorRef,
    showControls,
    subtitleTracks,
    currentSubtitleId,
    onChangeSubtitle,
    subtitleOffset,
    shiftSubtitles,
    secondSubtitle,
    subtitleGeneration,
    subtitleStyle,
  } = props;
  const t = useT();
  const v: MenuViewContext = { ...props, t };
  const menuParent = menu ? MENU_PARENT[menu] : undefined;

  return (
    <LiquidMenu
      menuRef={menuRef}
      anchorRef={anchorRef}
      view={menu}
      title={MENU_TITLES[menu] ? t(MENU_TITLES[menu]) : ""}
      icon={MENU_ICONS[menu] ?? null}
      /* w-72 rather than w-56: the subtitle offset row asks for a label and three controls
         side by side, which came to about two hundred and sixty pixels — so it overflowed,
         and a box that scrolls in one direction scrolls in both, which is where the
         horizontal bar came from. Wide enough that the row fits and "Taille sous-titres"
         stops wrapping onto two lines with it. Le verre, l'ancrage sur la pilule et la
         découpe qui en naît : `LiquidMenu`. */
      className="player-menu player-fade player-chrome-right pointer-events-auto absolute z-30 w-72 max-w-[calc(100vw-2rem)] overflow-x-hidden rounded-[22px]"
      style={{
        // `bottom` deliberately not set here: an absolutely-positioned element with both
        // `top` and `bottom` stretches to fill the space between them regardless of
        // content — which made this menu always ~half the screen tall even with only 2-3
        // items. The menu otherwise just sizes to its content.
        // Repli tant que la pilule n'est pas mesurée ; `LiquidMenu` ancre ensuite le menu
        // sur elle, et le borne à 280 px de haut — une liste plus longue défile plutôt que
        // de couvrir le film (04/10/2026).
        bottom: `calc(${BOTTOM_EDGE} + 5.75rem)`,
        maxHeight: `min(280px, calc(100dvh - ${BOTTOM_EDGE} - 10.5rem))`,
      }}
      onClick={(e) => e.stopPropagation()}
      onClickCapture={() => showControls(10000)}
    >
      {menu === "more" && moreView(v)}
      {menuParent && (
        <button
          onClick={() => setMenu(menuParent)}
          className="flex w-full items-center gap-2 border-b border-white/10 px-3 py-2 text-left text-sm text-white/70 hover:bg-white/10"
        >
          <ArrowLeft size={14} /> {t('common.back')}
        </button>
      )}
      {(menu === "audio" || menu === "subtitles") && tracksView(v)}
      {menu === "audio" && dialogueRowView(v)}
      {menu === "subtitles" && (
        <MenuOption
          on={currentSubtitleId === null}
          onClick={() => {
            onChangeSubtitle(null);
            setMenu(null);
          }}
        >
          {t('player.none')}
        </MenuOption>
      )}
      {/* « Générer des sous-titres » : sous les pistes, comme « Améliorer les dialogues » sous
          celles du son — le nom et un chevron vers le choix de la langue. La reprise d'une
          génération en pause vit ici aussi : c'est là que le spectateur voit l'entrée en pause. */}
      {menu === "subtitles" && subtitleGeneration && (
        <div className="border-t border-white/10">
          {subtitleGeneration.targets.length > 0 && (
            <button
              data-subtitle-gen-row
              disabled={subtitleGeneration.busy}
              onClick={() => setMenu("subtitleGen")}
              className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm text-white hover:bg-white/10 disabled:opacity-50"
            >
              <span className="flex min-w-0 items-center gap-2">
                <Languages size={16} className="shrink-0" />
                <span className="truncate">{t("player.subtitleGen.generate")}</span>
              </span>
              <ChevronRight size={14} className="shrink-0 text-white/50" />
            </button>
          )}
          {subtitleGeneration.resumable.map((entry) => (
            <button
              key={entry.code}
              data-subtitle-gen-resume={entry.code}
              onClick={() => {
                subtitleGeneration.onResume(entry.code);
                setMenu(null);
              }}
              className="block w-full px-3 py-2 text-left text-sm text-white hover:bg-white/10"
            >
              {t("player.subtitleGen.resume", { language: entry.label })}
            </button>
          ))}
        </div>
      )}
      {/* La langue du compte d'abord, d'un geste ; les autres derrière « Autre langue… », pour
          que le cas courant ne demande pas de parcourir une liste. */}
      {menu === "subtitleGen" && subtitleGeneration && subtitleGeneration.targets.length > 0 && (
        <>
          <button
            data-subtitle-gen-target={subtitleGeneration.targets[0].code}
            disabled={subtitleGeneration.busy}
            onClick={() => {
              subtitleGeneration.onGenerate(subtitleGeneration.targets[0].code);
              setMenu(null);
            }}
            className="block w-full px-3 py-2 text-left text-sm text-white hover:bg-white/10 disabled:opacity-50"
          >
            {subtitleGeneration.targets[0].label}
          </button>
          {subtitleGeneration.targets.length > 1 && (
            <button
              data-subtitle-gen-other
              onClick={() => setMenu("subtitleGenOther")}
              className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm text-white hover:bg-white/10"
            >
              {t("player.subtitleGen.otherLanguage")}
              <ChevronRight size={14} className="shrink-0 text-white/50" />
            </button>
          )}
        </>
      )}
      {menu === "subtitleGenOther" &&
        subtitleGeneration &&
        subtitleGeneration.targets.slice(1).map((target) => (
          <button
            key={target.code}
            data-subtitle-gen-target={target.code}
            disabled={subtitleGeneration.busy}
            onClick={() => {
              subtitleGeneration.onGenerate(target.code);
              setMenu(null);
            }}
            className="block w-full px-3 py-2 text-left text-sm text-white hover:bg-white/10 disabled:opacity-50"
          >
            {target.label}
          </button>
        ))}
      {/* Sous les pistes, ce qui règle leur affichage : l'apparence (une porte, la taille, la
          couleur et le fond se réglant ensemble) et, une piste choisie, son décalage. */}
      {menu === "subtitles" && (
        <div className="border-t border-white/10">
          <button
            onClick={() => setMenu("subtitleStyle")}
            className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm text-white hover:bg-white/10"
          >
            {t("player.subtitleStyle.title")}
            <ChevronRight size={14} className="shrink-0 text-white/50" />
          </button>
          {currentSubtitleId !== null && (
            <OffsetRow label={t("player.subtitleOffset")} seconds={subtitleOffset} onShift={shiftSubtitles} />
          )}
        </div>
      )}
      {menu === "subtitles" && dualRowView(v)}
      {menu === "dual" && dualView(v)}
      {menu === "dualPrimary" && dualPrimaryView(v)}
      {menu === "dualSecond" && dualSecondView(v)}
      {menu === "subtitleStyle" && (
        <>
          <SubtitleStyleGroup
            label={t("player.subtitleSize")}
            options={SUBTITLE_SIZES.map((s) => ({ value: s.value, label: t(`player.${s.labelKey}`) }))}
            current={subtitleStyle.size}
            onPick={(size) => subtitleStyleStore.set({ size })}
          />
          <SubtitleStyleGroup
            label={t("player.subtitleStyle.colour")}
            options={SUBTITLE_COLORS.map((c) => ({ value: c, label: t(`player.subtitleStyle.colours.${c}`) }))}
            current={subtitleStyle.color}
            onPick={(color) => subtitleStyleStore.set({ color })}
          />
          <SubtitleStyleGroup
            label={t("player.subtitleStyle.background")}
            options={SUBTITLE_BACKGROUNDS.map((b) => ({
              value: b,
              label: t(`player.subtitleStyle.backgrounds.${b}`),
            }))}
            current={subtitleStyle.background}
            onPick={(background) => subtitleStyleStore.set({ background })}
          />
        </>
      )}
      {menu === "hdrCap" && hdrCapHintView(v)}
      {menu === "hdrCap" && hdrCapView(v)}
      {menu === "sleep" && sleepView(v)}
      {menu === "quality" && qualityView(v)}
      {menu === "dialogue" && dialogueView(v)}
      {menu === "speed" && speedView(v)}
      {menu === "episodes" && episodesView(v)}
      {menu === "chapters" && chaptersView(v)}
    </LiquidMenu>
  );
}
