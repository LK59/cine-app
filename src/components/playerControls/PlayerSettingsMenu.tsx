"use client";

/**
 * Les menus du lecteur, nés de la pilule des réglages : les vues (audio, sous-titres, « … » et leurs
 * sous-vues), leur titre, leur « Retour », et les lignes de choix qu'elles partagent. Sortis de
 * `PlayerControls` tels quels ; l'état du menu ouvert reste chez lui, qui le referme aussi.
 */

import type { RefObject } from "react";
import { Captions, AudioLines, MonitorSmartphone, Info, Gauge, ListVideo, EllipsisVertical, ArrowLeft, Sun, Scan, Moon, Timer, ChevronRight, Speech, Languages, Layers } from "lucide-react";
import type { DialogueMode } from "@/lib/webcodecs/dialogueEnhance";
import { HDR_CAP_CHOICES, type HdrCapChoice } from "@/lib/webcodecs/hdrDisplay";
import { useT } from "@/components/TranslationProvider";
import { formatTime } from "@/lib/playerClock";
import { LiquidMenu } from "@/components/player/LiquidMenu";
import { PlayerEpisodesMenu } from "@/components/player/PlayerEpisodesMenu";
import { PlayerDownloadRow } from "@/components/player/PlayerDownloadRow";
import { noteViewerPresent } from "@/lib/autoAdvance";
import { subtitleStyleStore, SUBTITLE_SIZES, SUBTITLE_COLORS, SUBTITLE_BACKGROUNDS, type SubtitleStyle } from "@/lib/subtitleStyle";
import { writePlaybackQuality, type PlaybackQuality } from "@/lib/playbackQuality";
import { SLEEP_DURATIONS, sleepTimerStore, type SleepMode } from "@/lib/sleepTimer";
import type { TrickplayInfo } from "@/lib/trickplayTile";
import type { PlayerItemPayload } from "@/app/api/player/item/[itemId]/route";
import type { SecondSubtitleMenu, SubtitleGenerationMenu, Track } from "@/components/PlayerControls";
import { BOTTOM_EDGE } from "@/components/playerControls/layout";
import { DialogueBeta, MenuOption, OffsetRow, SubtitleStyleGroup } from "@/components/playerControls/menuRows";

/** « Améliorer les dialogues » : les trois choix du sous-menu, avec les mots et dans l'ordre de
 *  l'Apple TV (Désactivé / Améliorer / Améliorer davantage — demande de Louis, 11/10/2026). */
const DIALOGUE_CHOICES: { mode: DialogueMode; label: string }[] = [
  { mode: "off", label: "player.dialogue.off" },
  { mode: "on", label: "player.dialogue.enhance" },
  { mode: "strong", label: "player.dialogue.further" },
];
const PLAYBACK_SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];

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

export function PlayerSettingsMenu({
  menu,
  setMenu,
  menuRef,
  anchorRef,
  showControls,
  itemId,
  playerItem,
  downloadable,
  audioTracks,
  currentAudioId,
  onChangeAudio,
  subtitleTracks,
  currentSubtitleId,
  onChangeSubtitle,
  subtitleOffset,
  shiftSubtitles,
  secondSubtitle,
  secondId,
  secondOffset,
  shiftSecond,
  subtitleGeneration,
  subtitleStyle,
  dialogue,
  hdrCap,
  frameFit,
  quality,
  speed,
  changeSpeed,
  sleepMode,
  sleepMinutes,
  nextEpisode,
  onCastReturn,
  castActive,
  castSupported,
  chromecast,
  onTogglePlaybackInfo,
  episodesSeriesId,
  onPlayEpisode,
  chapters,
  jumpToChapter,
  currentTime,
  trickplay,
  trickplayTileAt,
}: {
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
}) {
  const t = useT();
  const menuParent = menu ? MENU_PARENT[menu] : undefined;
  /** « Auto · 203 nits », « Natif », « 400 nits » — le réglage de luminosité HDR, en mots. */
  const hdrCapLabel = (choice: HdrCapChoice): string =>
    choice === "auto"
      ? `${t("player.hdrCap.auto")}${hdrCap?.autoNits ? ` · ${hdrCap.autoNits} nits` : ` · ${t("player.hdrCap.native")}`}`
      : choice === "native"
        ? t("player.hdrCap.native")
        : `${choice} nits`;
  /** Ce qu'on peut prendre comme second : toute piste du menu sauf le principal. */
  const secondChoices = (secondSubtitle?.tracks ?? subtitleTracks).filter((tr) => tr.id !== currentSubtitleId);
  const labelOf = (id: number | null) => (id === null ? t("player.none") : (subtitleTracks.find((tr) => tr.id === id)?.label ?? t("player.none")));
  /**
   * Choisir le principal depuis « Deux sous-titres ». Prendre le second comme principal les échange :
   * l'hôte retire d'abord le second devenu principal, puis reçoit l'ancien principal comme second.
   */
  function pickPrimary(id: number) {
    const previous = currentSubtitleId;
    if (id === previous) return;
    onChangeSubtitle(id);
    if (secondSubtitle && id === secondSubtitle.currentId) secondSubtitle.onChange(previous);
  }
  const sleepLabel = (mode: SleepMode): string =>
    mode === "off" ? t("player.sleep.off") : mode === "episode" ? t("player.sleep.episode") : t("player.sleep.minutes", { n: Number(mode) });
  // Fixed small thumbnail size for the chapters menu — cropped to a consistent 16:9-ish box
  // regardless of Jellyfin's actual trickplay tile resolution, so the list stays tidy even if
  // that resolution ever changes.
  const chapterThumbWidth = 64;
  const chapterThumbScale = trickplay ? chapterThumbWidth / trickplay.width : 1;
  const chapterThumbHeight = trickplay ? Math.round(trickplay.height * chapterThumbScale) : 36;

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
      {/* ⋮ : ce qu'on règle en regardant — chapitres, vitesse, minuterie —, puis, sous un trait
          et en plus discret, ce qu'on ne touche que pour comprendre ou ajuster l'appareil.
          Les réglages des sous-titres vivent dans le menu des sous-titres : ils avaient ici
          la même icône que lui, et deux lignes de plus pour une question qui n'est pas d'ici. */}
      {menu === "more" && (
        <>
          {chapters.length > 0 && (
            <button
              onClick={() => setMenu("chapters")}
              className="flex w-full items-center gap-3 px-3 py-2 text-left text-sm text-white hover:bg-white/10"
            >
              <ListVideo size={16} /> {t('player.chapters')}
            </button>
          )}
          {/* La vitesse vit ici depuis le 11/10/2026 : un bouton à elle seule dans la barre pour
              un réglage qu'on touche rarement. La vitesse courante reste lisible dans la ligne. */}
          <button
            data-player-nav="speed"
            onClick={() => setMenu("speed")}
            className="flex w-full items-center gap-3 px-3 py-2 text-left text-sm text-white hover:bg-white/10"
          >
            <Gauge size={16} /> {t("player.speed")} · {speed === 1 ? t("player.speedNormal") : `${speed}×`}
          </button>
          {/* Active, la lune à la place du chronomètre, et ce qui reste. Rien d'autre à l'écran
              ne dit qu'une minuterie court. */}
          <button
            onClick={() => setMenu("sleep")}
            className="flex w-full items-center gap-3 px-3 py-2 text-left text-sm text-white hover:bg-white/10"
          >
            {sleepMode === "off" ? <Timer size={16} /> : <Moon size={16} fill="currentColor" data-sleep-active="" />}
            {t("player.sleep.title")}
            {sleepMode === "episode"
              ? ` · ${t("player.sleep.episode")}`
              : sleepMinutes !== null
                ? ` · ${t("player.sleep.minutes", { n: sleepMinutes })}`
                : ""}
          </button>
          {/* Le retour, tant que cette séance existe pour diffuser. Il ne dépend d'aucun
              événement — voir `onCastReturn` — et c'est précisément ce qui le rend sûr :
              la seule partie de la diffusion qu'on ne puisse pas éprouver depuis ici est
              la détection, et celle-ci s'en passe. La diffusion elle-même est en haut. */}
          {onCastReturn && (
            <button
              onClick={() => {
                onCastReturn();
                setMenu(null);
              }}
              className="flex w-full items-center gap-3 px-3 py-2 text-left text-sm text-white hover:bg-white/10"
            >
              <MonitorSmartphone size={16} />
              {castActive ? t("player.castStop") : t("player.castReturn")}
            </button>
          )}
          {frameFit && (
            // Le menu reste ouvert : l'image glisse derrière, et c'est ce qu'on veut voir.
            <button
              type="button"
              role="switch"
              aria-checked={frameFit.on}
              onClick={() => frameFit.onChange(!frameFit.on)}
              className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm text-white hover:bg-white/10"
            >
              <span className="flex items-center gap-3">
                <Scan size={16} /> {t("player.frameFit")}
              </span>
              <span
                aria-hidden
                className={`relative inline-block h-5 w-9 shrink-0 rounded-full transition-colors ${frameFit.on ? "bg-white/80" : "bg-white/20"}`}
              >
                <span
                  className={`absolute left-0.5 top-0.5 h-4 w-4 rounded-full transition-transform ${frameFit.on ? "translate-x-4 bg-black" : "bg-white"}`}
                />
              </span>
            </button>
          )}
          <div data-menu-secondary className="border-t border-white/[0.08]">
            <button
              onClick={() => {
                onTogglePlaybackInfo();
                setMenu(null);
              }}
              className="flex w-full items-center gap-3 px-3 py-2 text-left text-sm text-white/85 hover:bg-white/10"
            >
              <Info size={16} /> {t('player.playbackInfo')}
            </button>
            {/* « Qualité » (§78) : Automatique — la vidéo allégée prend le relais d'elle-même sur une
                connexion trop lente — ou Originale. Jamais de vidéo allégée à la demande. */}
            <button
              data-quality-row=""
              onClick={() => setMenu("quality")}
              className="flex w-full items-center gap-3 px-3 py-2 text-left text-sm text-white/85 hover:bg-white/10"
            >
              <Gauge size={16} /> {t("player.quality.title")} · {quality === "original" ? t("player.quality.original") : t("player.quality.auto")}
            </button>
            {hdrCap && (
              <button
                onClick={() => setMenu("hdrCap")}
                className="flex w-full items-center gap-3 px-3 py-2 text-left text-sm text-white/85 hover:bg-white/10"
              >
                <Sun size={16} /> {t("player.hdrCap.title")} · {hdrCapLabel(hdrCap.current)}
              </button>
            )}
            {/* Le fichier d'origine, au bureau seulement et pour un compte que Jellyfin autorise à
                télécharger (19/10/2026) — la route le vérifie aussi, cacher la ligne n'est pas
                interdire. Le navigateur le télécharge lui-même, avec sa reprise. */}
            {downloadable && (
              <PlayerDownloadRow itemId={itemId} sizeBytes={playerItem?.download?.sizeBytes ?? null} onStart={() => setMenu(null)} />
            )}
          </div>
        </>
      )}
      {menuParent && (
        <button
          onClick={() => setMenu(menuParent)}
          className="flex w-full items-center gap-2 border-b border-white/10 px-3 py-2 text-left text-sm text-white/70 hover:bg-white/10"
        >
          <ArrowLeft size={14} /> {t('common.back')}
        </button>
      )}
      {(menu === "audio" || menu === "subtitles") &&
        (menu === "audio" ? audioTracks : subtitleTracks).map((tr) => (
          <MenuOption
            key={tr.id}
            on={(menu === "audio" ? currentAudioId : currentSubtitleId) === tr.id}
            onClick={() => {
              if (menu === "audio") onChangeAudio(tr.id);
              // Le second pris comme principal : les deux s'échangent (§87).
              else if (secondSubtitle && tr.id === secondSubtitle.currentId) pickPrimary(tr.id);
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
        ))}
      {/* Sous les pistes, comme sur l'Apple TV : c'est un réglage du son, il vivait dans le
          menu « … » jusqu'au 11/10/2026. Le nom seul et un chevron, comme l'apparence des
          sous-titres : l'état coupé en « … » sur un téléphone ne disait rien. */}
      {menu === "audio" && dialogue && (
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
      )}
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
      {/* « Deux sous-titres » (§87) : sous l'apparence, une porte comme elle. Proposée dès qu'il y a
          de quoi faire deux — deux pistes, ou une piste et une langue à générer. La ligne dit le
          second retenu, pour qu'on sache sans ouvrir que le mode est actif. */}
      {menu === "subtitles" &&
        secondSubtitle &&
        (subtitleTracks.length >= 2 || (subtitleTracks.length >= 1 && (secondSubtitle.generation?.targets.length ?? 0) > 0)) && (
          <button
            data-dual-subtitles-row
            onClick={() => setMenu("dual")}
            className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm text-white hover:bg-white/10"
          >
            <span className="truncate">{t("player.dualSubtitles.title")}</span>
            <span className="flex min-w-0 items-center gap-1">
              {secondId !== null && <span className="truncate text-xs text-white/50">{labelOf(secondId)}</span>}
              <ChevronRight size={14} className="shrink-0 text-white/50" />
            </span>
          </button>
        )}
      {menu === "dual" && secondSubtitle && (
        <>
          <button
            data-dual-primary-row
            onClick={() => setMenu("dualPrimary")}
            className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm text-white hover:bg-white/10"
          >
            <span className="shrink-0">{t("player.dualSubtitles.primary")}</span>
            <span className="flex min-w-0 items-center gap-1">
              <span className="truncate text-xs text-white/50">{labelOf(currentSubtitleId)}</span>
              <ChevronRight size={14} className="shrink-0 text-white/50" />
            </span>
          </button>
          <button
            data-dual-second-row
            disabled={currentSubtitleId === null}
            onClick={() => setMenu("dualSecond")}
            className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm text-white hover:bg-white/10 disabled:opacity-50"
          >
            <span className="shrink-0">{t("player.dualSubtitles.second")}</span>
            <span className="flex min-w-0 items-center gap-1">
              <span className="truncate text-xs text-white/50">{labelOf(secondId)}</span>
              <ChevronRight size={14} className="shrink-0 text-white/50" />
            </span>
          </button>
          {currentSubtitleId === null && (
            <p className="px-3 pb-2 text-xs text-white/50">{t("player.dualSubtitles.primaryFirst")}</p>
          )}
          {secondId !== null && (
            <div className="border-t border-white/10">
              <OffsetRow label={t("player.dualSubtitles.secondOffset")} seconds={secondOffset} onShift={shiftSecond} />
              <button
                data-dual-off
                onClick={() => {
                  secondSubtitle.onChange(null);
                  setMenu("subtitles");
                }}
                className="block w-full px-3 py-2 text-left text-sm text-white hover:bg-white/10"
              >
                {t("player.dualSubtitles.off")}
              </button>
            </div>
          )}
          {/* Ce que la télévision reçoit, dit simplement : AirPlay et le Chromecast ne prennent
              que le principal — le second est dessiné par cette page, qui n'est pas à l'écran. */}
          {(castSupported || !!chromecast) && (
            <p data-dual-tv-note className="border-t border-white/10 px-3 py-2 text-xs text-white/50">
              {t("player.dualSubtitles.tvNote")}
            </p>
          )}
        </>
      )}
      {menu === "dualPrimary" &&
        subtitleTracks.map((tr) => (
          <MenuOption
            key={tr.id}
            data-dual-primary={tr.id}
            on={currentSubtitleId === tr.id}
            onClick={() => {
              pickPrimary(tr.id);
              setMenu("dual");
            }}
          >
            <span className="min-w-0 line-clamp-2">{tr.label}</span>
          </MenuOption>
        ))}
      {menu === "dualSecond" && secondSubtitle && (
        <>
          <MenuOption
            data-dual-second="none"
            on={secondId === null}
            onClick={() => {
              secondSubtitle.onChange(null);
              setMenu("dual");
            }}
          >
            {t("player.none")}
          </MenuOption>
          {secondChoices.map((tr) => (
            <MenuOption
              key={tr.id}
              data-dual-second={tr.id}
              on={secondId === tr.id}
              onClick={() => {
                secondSubtitle.onChange(tr.id);
                setMenu("dual");
              }}
            >
              <span className="min-w-0 line-clamp-2">
                {tr.label}
                {tr.detail && <span className="ml-2 text-xs tabular-nums text-white/50">{tr.detail}</span>}
              </span>
            </MenuOption>
          ))}
          {/* Générer le second, à la volée depuis la position — la même demande, les mêmes limites et
              les mêmes messages que « Générer des sous-titres » (§70). */}
          {secondSubtitle.generation && secondSubtitle.generation.targets.length > 0 && (
            <div className="border-t border-white/10">
              {secondSubtitle.generation.targets.map((target) => (
                <button
                  key={target.code}
                  data-dual-generate={target.code}
                  disabled={secondSubtitle.generation!.busy}
                  onClick={() => {
                    secondSubtitle.generation!.onGenerate(target.code);
                    setMenu(null);
                  }}
                  className="flex w-full items-start gap-2 px-3 py-2 text-left text-sm text-white hover:bg-white/10 disabled:opacity-50"
                >
                  <Languages size={16} aria-hidden className="mt-0.5 shrink-0" />
                  <span className="min-w-0 line-clamp-2">{t("player.dualSubtitles.generate", { language: target.label })}</span>
                </button>
              ))}
            </div>
          )}
        </>
      )}
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
      {menu === "hdrCap" && hdrCap && (
        <p className="max-w-64 px-3 pb-1 pt-2 text-xs text-white/60">{t("player.hdrCap.hint")}</p>
      )}
      {menu === "hdrCap" &&
        hdrCap &&
        HDR_CAP_CHOICES.map((choice) => (
          <MenuOption
            key={String(choice)}
            on={hdrCap.current === choice}
            onClick={() => {
              setMenu(null);
              if (choice !== hdrCap.current) hdrCap.onPick(choice);
            }}
          >
            {hdrCapLabel(choice)}
          </MenuOption>
        ))}
      {menu === "sleep" &&
        // « Fin de l'épisode » seulement quand il y a un épisode après : sans lui, l'épisode
        // s'arrête déjà à sa fin, et l'option ne changerait rien.
        (["off", ...SLEEP_DURATIONS, ...(nextEpisode ? (["episode"] as const) : [])] as SleepMode[]).map((choice) => (
          <MenuOption
            key={choice}
            on={sleepMode === choice}
            onClick={() => {
              setMenu(null);
              // Rechoisir la durée en cours la relance en entier, comme « Continuer ».
              sleepTimerStore.choose(choice);
            }}
          >
            {sleepLabel(choice)}
          </MenuOption>
        ))}
      {/* Comme l'audio et les sous-titres : trois choix dans une liste, le courant en couleur.
          Choisir reconstruit la lecture au même endroit (le traitement vit dans la chaîne audio)
          et referme le menu, comme un changement de piste. */}
      {menu === "quality" && (
        <>
          {(["auto", "original"] as const).map((choice) => (
            <MenuOption
              key={choice}
              data-quality-choice={choice}
              on={quality === choice}
              onClick={() => {
                if (choice !== quality) writePlaybackQuality(choice);
                setMenu(null);
              }}
            >
              {choice === "auto" ? t("player.quality.auto") : t("player.quality.original")}
            </MenuOption>
          ))}
          <p className="border-t border-white/10 px-3 pt-2 pb-2 text-xs text-white/60">{t("player.quality.hint")}</p>
        </>
      )}
      {menu === "dialogue" && dialogue && (
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
      )}
      {menu === "speed" &&
        PLAYBACK_SPEEDS.map((rate) => (
          <MenuOption key={rate} on={speed === rate} onClick={() => changeSpeed(rate)}>
            {rate === 1 ? t('player.speedNormal') : `${rate}x`}
          </MenuOption>
        ))}
      {menu === "episodes" && episodesSeriesId && onPlayEpisode && (
        <PlayerEpisodesMenu
          seriesId={episodesSeriesId}
          currentItemId={itemId}
          onPick={(episode) => {
            setMenu(null);
            noteViewerPresent();
            onPlayEpisode(episode);
          }}
        />
      )}
      {menu === "chapters" &&
        chapters.map((ch, i) => {
          const tile = trickplayTileAt(ch.start);
          return (
            <MenuOption
              key={i}
              align="center"
              on={currentTime >= ch.start && (chapters[i + 1] ? currentTime < chapters[i + 1].start : true)}
              onClick={() => jumpToChapter(ch.start)}
            >
              {trickplay && (
                <div
                  className="shrink-0 overflow-hidden rounded bg-black/40"
                  style={{ width: chapterThumbWidth, height: chapterThumbHeight }}
                >
                  {tile && (
                    <div
                      style={{
                        width: trickplay.width,
                        height: trickplay.height,
                        transform: `scale(${chapterThumbScale})`,
                        transformOrigin: "top left",
                        backgroundImage: `url(${tile.url})`,
                        backgroundPosition: `${tile.bgX}px ${tile.bgY}px`,
                        backgroundSize: `${trickplay.width * trickplay.tileWidth}px ${trickplay.height * trickplay.tileHeight}px`,
                      }}
                    />
                  )}
                </div>
              )}
              <span className="min-w-0 flex-1 truncate">{ch.name ?? t("player.chapterN", { n: i + 1 })}</span>
              <span className="shrink-0 tabular-nums text-white/50">{formatTime(ch.start)}</span>
            </MenuOption>
          );
        })}
    </LiquidMenu>
  );
}
