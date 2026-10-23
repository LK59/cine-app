"use client";

/**
 * Les menus du lecteur, nés de la pilule des réglages : leur titre, leur « Retour », et l'aiguillage
 * vers les vues (audio, sous-titres, « … » et leurs sous-vues), écrites dans `menuViews*.tsx`. Sortis
 * de `PlayerControls` tels quels ; l'état du menu ouvert reste chez lui, qui le referme aussi.
 */

import type { RefObject } from "react";
import { Captions, AudioLines, Gauge, ListVideo, EllipsisVertical, ArrowLeft, Sun, Timer, Languages, Layers } from "lucide-react";
import type { DialogueMode } from "@/lib/webcodecs/dialogueEnhance";
import type { HdrCapChoice } from "@/lib/webcodecs/hdrDisplay";
import { useT } from "@/components/TranslationProvider";
import { LiquidMenu } from "@/components/player/LiquidMenu";
import type { SubtitleStyle } from "@/lib/subtitleStyle";
import type { PlaybackQuality } from "@/lib/playbackQuality";
import type { SleepMode } from "@/lib/sleepTimer";
import type { TrickplayInfo } from "@/lib/trickplayTile";
import type { PlayerItemPayload } from "@/app/api/player/item/[itemId]/route";
import type { SecondSubtitleMenu, SubtitleGenerationMenu, Track } from "@/components/PlayerControls";
import { BOTTOM_EDGE } from "@/components/playerControls/layout";
import { dialogueRowView, dialogueView, tracksView } from "@/components/playerControls/menuViewsAudio";
import { subtitleGenOtherView, subtitleGenRowsView, subtitleGenView, subtitleStyleView, subtitlesDisplayView, subtitlesNoneView } from "@/components/playerControls/menuViewsSubtitles";
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
  const { menu, setMenu, menuRef, anchorRef, showControls } = props;
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
      {/* Une ligne par emplacement, chaque vue à la place qu'elle occupait parmi les enfants du
          menu. L'ordre compte : React rapproche ces enfants par leur position, et ce qui passe
          d'une vue à l'autre sans être recréé (le « Retour », une piste de même clé entre l'audio
          et les sous-titres) le doit à ces places. Une vue sur plusieurs lignes (les sous-titres)
          y reste répartie pour la même raison. */}
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
      {menu === "subtitles" && subtitlesNoneView(v)}
      {menu === "subtitles" && subtitleGenRowsView(v)}
      {menu === "subtitleGen" && subtitleGenView(v)}
      {menu === "subtitleGenOther" && subtitleGenOtherView(v)}
      {menu === "subtitles" && subtitlesDisplayView(v)}
      {menu === "subtitles" && dualRowView(v)}
      {menu === "dual" && dualView(v)}
      {menu === "dualPrimary" && dualPrimaryView(v)}
      {menu === "dualSecond" && dualSecondView(v)}
      {menu === "subtitleStyle" && subtitleStyleView(v)}
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
