/**
 * Les vues des sous-titres : sous les pistes, « Aucun », la génération (la ligne, le choix de la
 * langue, les autres langues), l'apparence et le décalage. Des fonctions de rendu appelées à leur
 * place dans `PlayerSettingsMenu`, comme les autres vues ; la liste des pistes est celle de
 * l'audio (`tracksView`), « Deux sous-titres » vit dans `menuViewsDual.tsx`.
 */

import { ChevronRight, Languages } from "lucide-react";
import { subtitleStyleStore, SUBTITLE_SIZES, SUBTITLE_COLORS, SUBTITLE_BACKGROUNDS } from "@/lib/subtitleStyle";
import { MenuOption, OffsetRow, SubtitleStyleGroup } from "@/components/playerControls/menuRows";
import type { MenuViewContext } from "@/components/playerControls/PlayerSettingsMenu";

export function subtitlesNoneView({ t, setMenu, currentSubtitleId, onChangeSubtitle }: MenuViewContext) {
  return (
    <MenuOption
      on={currentSubtitleId === null}
      onClick={() => {
        onChangeSubtitle(null);
        setMenu(null);
      }}
    >
      {t('player.none')}
    </MenuOption>
  );
}

/* « Générer des sous-titres » : sous les pistes, comme « Améliorer les dialogues » sous
   celles du son — le nom et un chevron vers le choix de la langue. La reprise d'une
   génération en pause vit ici aussi : c'est là que le spectateur voit l'entrée en pause. */
export function subtitleGenRowsView({ t, setMenu, subtitleGeneration }: MenuViewContext) {
  return (
    subtitleGeneration && (
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
    )
  );
}

/* La langue du compte d'abord, d'un geste ; les autres derrière « Autre langue… », pour
   que le cas courant ne demande pas de parcourir une liste. */
export function subtitleGenView({ t, setMenu, subtitleGeneration }: MenuViewContext) {
  return (
    subtitleGeneration &&
    subtitleGeneration.targets.length > 0 && (
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
    )
  );
}

export function subtitleGenOtherView({ setMenu, subtitleGeneration }: MenuViewContext) {
  return (
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
    ))
  );
}

/* Sous les pistes, ce qui règle leur affichage : l'apparence (une porte, la taille, la
   couleur et le fond se réglant ensemble) et, une piste choisie, son décalage. */
export function subtitlesDisplayView({ t, setMenu, currentSubtitleId, subtitleOffset, shiftSubtitles }: MenuViewContext) {
  return (
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
  );
}

export function subtitleStyleView({ t, subtitleStyle }: MenuViewContext) {
  return (
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
  );
}
