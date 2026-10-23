/**
 * Les vues du menu « … » et celles qu'il ouvre (vitesse, minuterie, qualité, luminosité HDR,
 * chapitres), plus la liste des épisodes. Des fonctions de rendu, pas des composants : appelées à
 * leur place dans `PlayerSettingsMenu`, elles laissent l'arbre de React tel qu'il était.
 */

import { Gauge, Info, ListVideo, MonitorSmartphone, Moon, Scan, Sun, Timer } from "lucide-react";
import { HDR_CAP_CHOICES, type HdrCapChoice } from "@/lib/webcodecs/hdrDisplay";
import { formatTime } from "@/lib/playerClock";
import { PlayerEpisodesMenu } from "@/components/player/PlayerEpisodesMenu";
import { PlayerDownloadRow } from "@/components/player/PlayerDownloadRow";
import { noteViewerPresent } from "@/lib/autoAdvance";
import { writePlaybackQuality } from "@/lib/playbackQuality";
import { SLEEP_DURATIONS, sleepTimerStore, type SleepMode } from "@/lib/sleepTimer";
import { MenuOption } from "@/components/playerControls/menuRows";
import type { MenuViewContext } from "@/components/playerControls/PlayerSettingsMenu";

const PLAYBACK_SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];

/** « Auto · 203 nits », « Natif », « 400 nits » — le réglage de luminosité HDR, en mots. */
function hdrCapLabel({ t, hdrCap }: MenuViewContext, choice: HdrCapChoice): string {
  return choice === "auto"
    ? `${t("player.hdrCap.auto")}${hdrCap?.autoNits ? ` · ${hdrCap.autoNits} nits` : ` · ${t("player.hdrCap.native")}`}`
    : choice === "native"
      ? t("player.hdrCap.native")
      : `${choice} nits`;
}

/* ⋮ : ce qu'on règle en regardant — chapitres, vitesse, minuterie —, puis, sous un trait
   et en plus discret, ce qu'on ne touche que pour comprendre ou ajuster l'appareil.
   Les réglages des sous-titres vivent dans le menu des sous-titres : ils avaient ici
   la même icône que lui, et deux lignes de plus pour une question qui n'est pas d'ici. */
export function moreView(v: MenuViewContext) {
  const { t, setMenu, chapters, speed, sleepMode, sleepMinutes, onCastReturn, castActive, frameFit, onTogglePlaybackInfo, quality, hdrCap, downloadable, itemId, playerItem } = v;
  return (
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
            <Sun size={16} /> {t("player.hdrCap.title")} · {hdrCapLabel(v, hdrCap.current)}
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
  );
}

/** Luminosité HDR : la phrase qui l'explique, au-dessus des choix. */
export function hdrCapHintView({ t, hdrCap }: MenuViewContext) {
  return hdrCap && <p className="max-w-64 px-3 pb-1 pt-2 text-xs text-white/60">{t("player.hdrCap.hint")}</p>;
}

export function hdrCapView(v: MenuViewContext) {
  const { hdrCap, setMenu } = v;
  return (
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
        {hdrCapLabel(v, choice)}
      </MenuOption>
    ))
  );
}

export function sleepView({ t, setMenu, sleepMode, nextEpisode }: MenuViewContext) {
  const sleepLabel = (mode: SleepMode): string =>
    mode === "off" ? t("player.sleep.off") : mode === "episode" ? t("player.sleep.episode") : t("player.sleep.minutes", { n: Number(mode) });
  return (
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
    ))
  );
}

/* Comme l'audio et les sous-titres : trois choix dans une liste, le courant en couleur.
   Choisir reconstruit la lecture au même endroit (le traitement vit dans la chaîne audio)
   et referme le menu, comme un changement de piste. */
export function qualityView({ t, setMenu, quality }: MenuViewContext) {
  return (
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
  );
}

export function speedView({ t, speed, changeSpeed }: MenuViewContext) {
  return PLAYBACK_SPEEDS.map((rate) => (
    <MenuOption key={rate} on={speed === rate} onClick={() => changeSpeed(rate)}>
      {rate === 1 ? t('player.speedNormal') : `${rate}x`}
    </MenuOption>
  ));
}

export function episodesView({ setMenu, episodesSeriesId, onPlayEpisode, itemId }: MenuViewContext) {
  return (
    episodesSeriesId &&
    onPlayEpisode && (
      <PlayerEpisodesMenu
        seriesId={episodesSeriesId}
        currentItemId={itemId}
        onPick={(episode) => {
          setMenu(null);
          noteViewerPresent();
          onPlayEpisode(episode);
        }}
      />
    )
  );
}

export function chaptersView({ t, chapters, trickplay, trickplayTileAt, currentTime, jumpToChapter }: MenuViewContext) {
  // Fixed small thumbnail size for the chapters menu — cropped to a consistent 16:9-ish box
  // regardless of Jellyfin's actual trickplay tile resolution, so the list stays tidy even if
  // that resolution ever changes.
  const chapterThumbWidth = 64;
  const chapterThumbScale = trickplay ? chapterThumbWidth / trickplay.width : 1;
  const chapterThumbHeight = trickplay ? Math.round(trickplay.height * chapterThumbScale) : 36;
  return chapters.map((ch, i) => {
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
  });
}
