// « Générer des sous-titres » dans Lumen serveur (étape 4b, DECISIONS.md §187) : la génération du lecteur natif
// (`SubtitleGeneration`, §70) branchée sur cet hôte. La demande, le sondage, la position envoyée au serveur, les
// messages d'état et la bascule finale sont ceux du lecteur natif, sans une ligne de plus ; ce qui diffère est
// l'affichage. Une génération en cours n'a pas encore de fichier : ses lignes, reçues par morceaux, sont montrées par le
// calque de sous-titres de la page (`SubtitleLayer`, celui de toutes les pistes depuis §190), à l'instant de l'élément
// moins le décalage du menu, comme le lecteur natif. À la fin, Jellyfin présente le
// fichier : la liste des sous-titres est relue (`/api/lumen/{id}/pistes`) et la piste générée devient un `<track>`
// comme les autres, choisie à la place de l'entrée temporaire.
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore, type RefObject } from "react";
import { cueLookupTime } from "@/lib/subtitleSync";
import { reportPlayback } from "@/lib/reportPlayback";
import { isGeneratingTrack, SubtitleGeneration } from "@/lib/subtitleGen/generation";
import type { ExternalSubtitleSource } from "@/lib/webcodecs/externalSubtitles";
import { generationErrorText, generationMenu, noticeText } from "@/components/player/nativeHostHelpers";
import type { useT } from "@/components/TranslationProvider";

export interface LumenGenerationLine {
  text: string;
  notice: boolean;
}

export function useLumenSubtitleGeneration({
  itemId,
  enabled,
  videoRef,
  positionNow,
  logFields,
  externals,
  locale,
  t,
  currentId,
  offset = 0,
  onFinal,
  onFailed,
  onWarning,
}: {
  itemId: string;
  /** Ni banc, ni scène : la génération n'est pas ouverte (comme le lecteur natif). */
  enabled: boolean;
  videoRef: RefObject<HTMLVideoElement | null>;
  positionNow: () => number;
  logFields: () => Record<string, unknown>;
  /** Les fichiers à côté du film, tels que la description du fichier les donne (`generated` compris). */
  externals: readonly ExternalSubtitleSource[];
  locale: string;
  t: ReturnType<typeof useT>;
  /** Le sous-titre choisi : une entrée temporaire (`isGeneratingTrack`) est une génération qu'on montre. */
  currentId: number | null;
  /** Le décalage du principal (±0,5 s), tenu par l'hôte (§190) : la ligne cherchée à l'instant moins lui. */
  offset?: number;
  /** Jellyfin présente le fichier : l'hôte relit la liste et choisit la piste finale. */
  onFinal: (source: ExternalSubtitleSource) => void;
  /** La génération montrée a échoué : l'hôte retire le sous-titre. */
  onFailed: () => void;
  /** Un échec à dire, en passant — jamais une erreur de lecture. */
  onWarning: (text: string) => void;
}) {
  const [generation] = useState(() => new SubtitleGeneration({ itemId }));
  const state = useSyncExternalStore(generation.subscribe, generation.snapshot, generation.snapshot);
  const [line, setLine] = useState<LumenGenerationLine | null>(null);

  // Les rappels, recopiés à chaque rendu : ils lisent ce que ce rendu sait.
  useEffect(() => {
    generation.setHooks({
      position: positionNow,
      log: (fields) => reportPlayback("subtitle-gen", { ...logFields(), ...fields }),
      onError: (code, facts) => onWarning(generationErrorText(code, facts.quotaLimit, t)),
      onFinal: (target, source) => {
        if (isGeneratingTrack(currentId) && generation.targetOf(currentId) === target) onFinal(source);
      },
      onFailed: (target) => {
        if (isGeneratingTrack(currentId) && generation.targetOf(currentId) === target) onFailed();
      },
    });
  });

  // Ouverte avec l'hôte, fermée avec lui.
  useEffect(() => {
    if (!enabled) return;
    void generation.open();
    return () => generation.close();
  }, [generation, enabled]);

  // L'entrée choisie dans le menu est la génération active (sondée, avec la position) ; toute autre la désactive.
  useEffect(() => {
    generation.activate(isGeneratingTrack(currentId) ? currentId : null);
  }, [generation, currentId]);

  // La ligne à l'instant de l'élément : à chaque `timeupdate`, à chaque saut, et à chaque sondage qui apporte des lignes.
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !isGeneratingTrack(currentId)) {
      const clear = setTimeout(() => setLine(null), 0);
      return () => clearTimeout(clear);
    }
    const draw = () => {
      // Une génération est datée comme un fichier à côté du film ; ici l'horloge de l'élément est celle du fichier.
      const at = cueLookupTime(video.currentTime, 0, offset, 1, true);
      const text = generation.textAt(at);
      if (text) {
        generation.noteShown();
        setLine((previous) => (previous && !previous.notice && previous.text === text ? previous : { text, notice: false }));
        return;
      }
      const notice = generation.noticeAt(at);
      const noticeLine = notice ? noticeText(notice, t) : null;
      setLine((previous) => (noticeLine === null ? null : previous?.notice && previous.text === noticeLine ? previous : { text: noticeLine, notice: true }));
    };
    const onSeeking = () => generation.noteSeek(cueLookupTime(video.currentTime, 0, offset, 1, true));
    // Le premier dessin hors du corps de l'effet (la règle du compilateur React) : au tour suivant.
    const first = setTimeout(draw, 0);
    const unsubscribe = generation.subscribe(draw);
    video.addEventListener("timeupdate", draw);
    video.addEventListener("seeked", draw);
    video.addEventListener("seeking", onSeeking);
    return () => {
      clearTimeout(first);
      unsubscribe();
      video.removeEventListener("timeupdate", draw);
      video.removeEventListener("seeked", draw);
      video.removeEventListener("seeking", onSeeking);
    };
  }, [generation, currentId, videoRef, t, offset]);

  const view = useMemo(() => generationMenu(state, externals, locale, t), [state, externals, locale, t]);

  /** « Générer » dans le menu : la demande part ; l'entrée temporaire, rendue, devient la piste choisie. */
  const request = useCallback((code: string, choose: (id: number) => void) => {
    void generation.generate(code).then((id) => {
      if (id !== null) choose(id);
    });
  }, [generation]);

  return { generation, state, view, line, request };
}
