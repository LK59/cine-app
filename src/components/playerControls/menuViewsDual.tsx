/**
 * « Deux sous-titres » (§87) : la ligne qui y mène depuis les sous-titres, la vue elle-même et ses
 * deux listes (principal, second). Des fonctions de rendu appelées à leur place dans
 * `PlayerSettingsMenu`, comme les autres vues.
 */

import { ChevronRight, Languages } from "lucide-react";
import { MenuOption, OffsetRow } from "@/components/playerControls/menuRows";
import type { MenuViewContext } from "@/components/playerControls/PlayerSettingsMenu";

function labelOf({ t, subtitleTracks }: MenuViewContext, id: number | null) {
  return id === null ? t("player.none") : (subtitleTracks.find((tr) => tr.id === id)?.label ?? t("player.none"));
}

/**
 * Choisir le principal depuis « Deux sous-titres ». Prendre le second comme principal les échange :
 * l'hôte retire d'abord le second devenu principal, puis reçoit l'ancien principal comme second.
 */
export function pickPrimary({ currentSubtitleId, onChangeSubtitle, secondSubtitle }: MenuViewContext, id: number) {
  const previous = currentSubtitleId;
  if (id === previous) return;
  onChangeSubtitle(id);
  if (secondSubtitle && id === secondSubtitle.currentId) secondSubtitle.onChange(previous);
}

/* « Deux sous-titres » (§87) : sous l'apparence, une porte comme elle. Proposée dès qu'il y a
   de quoi faire deux — deux pistes, ou une piste et une langue à générer. La ligne dit le
   second retenu, pour qu'on sache sans ouvrir que le mode est actif. */
export function dualRowView(v: MenuViewContext) {
  const { t, setMenu, secondSubtitle, subtitleTracks, secondId } = v;
  return (
    secondSubtitle &&
    (subtitleTracks.length >= 2 || (subtitleTracks.length >= 1 && (secondSubtitle.generation?.targets.length ?? 0) > 0)) && (
      <button
        data-dual-subtitles-row
        onClick={() => setMenu("dual")}
        className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm text-white hover:bg-white/10"
      >
        <span className="truncate">{t("player.dualSubtitles.title")}</span>
        <span className="flex min-w-0 items-center gap-1">
          {secondId !== null && <span className="truncate text-xs text-white/50">{labelOf(v, secondId)}</span>}
          <ChevronRight size={14} className="shrink-0 text-white/50" />
        </span>
      </button>
    )
  );
}

export function dualView(v: MenuViewContext) {
  const { t, setMenu, secondSubtitle, currentSubtitleId, secondId, secondOffset, shiftSecond, castSupported, chromecast } = v;
  return (
    secondSubtitle && (
      <>
        <button
          data-dual-primary-row
          onClick={() => setMenu("dualPrimary")}
          className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm text-white hover:bg-white/10"
        >
          <span className="shrink-0">{t("player.dualSubtitles.primary")}</span>
          <span className="flex min-w-0 items-center gap-1">
            <span className="truncate text-xs text-white/50">{labelOf(v, currentSubtitleId)}</span>
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
            <span className="truncate text-xs text-white/50">{labelOf(v, secondId)}</span>
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
    )
  );
}

export function dualPrimaryView(v: MenuViewContext) {
  const { setMenu, subtitleTracks, currentSubtitleId } = v;
  return subtitleTracks.map((tr) => (
    <MenuOption
      key={tr.id}
      data-dual-primary={tr.id}
      on={currentSubtitleId === tr.id}
      onClick={() => {
        pickPrimary(v, tr.id);
        setMenu("dual");
      }}
    >
      <span className="min-w-0 line-clamp-2">{tr.label}</span>
    </MenuOption>
  ));
}

export function dualSecondView({ t, setMenu, secondSubtitle, subtitleTracks, currentSubtitleId, secondId }: MenuViewContext) {
  /** Ce qu'on peut prendre comme second : toute piste du menu sauf le principal. */
  const secondChoices = (secondSubtitle?.tracks ?? subtitleTracks).filter((tr) => tr.id !== currentSubtitleId);
  return (
    secondSubtitle && (
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
    )
  );
}
