// La génération de sous-titres dans le lecteur natif (`ExperimentalPlayerHost.tsx`, DECISIONS.md
// §70 et §87) : les rappels de `SubtitleGeneration`, son ouverture avec l'hôte, le redessin à chaque
// sondage, et « Générer » pour le principal et le second. Sorti tel quel de l'hôte le 23/10/2026,
// appelé à la même place.
import { useCallback, useEffect, type Dispatch, type RefObject, type SetStateAction } from "react";
import type { useT } from "@/components/TranslationProvider";
import { reportPlayback } from "@/lib/reportPlayback";
import { isGeneratingTrack, type SubtitleGeneration } from "@/lib/subtitleGen/generation";
import { ExternalSubtitleTrack, type ExternalSubtitleSource } from "@/lib/webcodecs/externalSubtitles";
import { generationErrorText } from "@/components/player/nativeHostHelpers";

export function useNativeSubtitleGeneration({
  generation,
  bench,
  shareMode,
  intendedPosition,
  describeFileRef,
  showWarning,
  tRef,
  setRefreshedExternals,
  wantedSubtitleRef,
  setCurrentSubtitle,
  setSubtitle,
  externalSubtitleRef,
  setSubtitleIsNotice,
  subtitleFetchRef,
  subtitleOffsetRef,
  secondWantedRef,
  setSecondSubtitle,
  secondExternalRef,
  setSecondIsNotice,
  secondFetchRef,
  secondOffsetRef,
  fileDelayRef,
  videoElRef,
  externalsRef,
  generationLane,
  clearSecond,
  showGeneratedAt,
  showSecondGeneratedAt,
  chooseSubtitle,
  chooseSecond,
}: {
  generation: SubtitleGeneration;
  bench: string | undefined;
  shareMode: boolean;
  intendedPosition: () => number;
  describeFileRef: RefObject<() => Record<string, unknown>>;
  showWarning: (text: string | null) => void;
  tRef: RefObject<ReturnType<typeof useT>>;
  setRefreshedExternals: Dispatch<SetStateAction<ExternalSubtitleSource[] | null>>;
  wantedSubtitleRef: RefObject<number | null>;
  setCurrentSubtitle: Dispatch<SetStateAction<number | null>>;
  setSubtitle: Dispatch<SetStateAction<string | null>>;
  externalSubtitleRef: RefObject<ExternalSubtitleTrack | null>;
  setSubtitleIsNotice: Dispatch<SetStateAction<boolean>>;
  subtitleFetchRef: RefObject<AbortController | null>;
  subtitleOffsetRef: RefObject<number>;
  secondWantedRef: RefObject<number | null>;
  setSecondSubtitle: Dispatch<SetStateAction<number | null>>;
  secondExternalRef: RefObject<ExternalSubtitleTrack | null>;
  setSecondIsNotice: Dispatch<SetStateAction<boolean>>;
  secondFetchRef: RefObject<AbortController | null>;
  secondOffsetRef: RefObject<number>;
  fileDelayRef: RefObject<number>;
  videoElRef: RefObject<HTMLVideoElement | null>;
  externalsRef: RefObject<ExternalSubtitleSource[]>;
  generationLane: () => "primary" | "second" | null;
  clearSecond: () => void;
  showGeneratedAt: (fileSeconds: number) => void;
  showSecondGeneratedAt: (fileSeconds: number) => void;
  chooseSubtitle: (id: number | null, sources: ExternalSubtitleSource[]) => void;
  chooseSecond: (id: number | null, sources: ExternalSubtitleSource[]) => void;
}) {
  // Les rappels de la génération, recopiés à chaque rendu : ils lisent ce que ce rendu sait.
  useEffect(() => {
    generation.setHooks({
      // La position voulue — la cible d'un saut pas encore atteint comprise : c'est elle qui dit au
      // serveur quoi traduire d'abord.
      position: () => intendedPosition(),
      log: (fields) => reportPlayback("subtitle-gen", { ...describeFileRef.current(), ...fields }),
      // Un message passager, comme une piste externe introuvable : jamais l'écran d'erreur.
      onError: (code, facts) => showWarning(generationErrorText(code, facts.quotaLimit, tRef.current)),
      onFinal: (target, source, list) => {
        setRefreshedExternals(list);
        // Le second qui affichait cette génération passe, lui aussi sans à-coup, sur la piste finale.
        const second = secondWantedRef.current;
        if (isGeneratingTrack(second) && generation.targetOf(second) === target) {
          secondWantedRef.current = source.id;
          setSecondSubtitle(source.id);
          secondExternalRef.current = ExternalSubtitleTrack.fromCues(source.id, generation.cuesOf(target));
          setSecondIsNotice(false);
          secondFetchRef.current?.abort();
          const fetchingSecond = new AbortController();
          secondFetchRef.current = fetchingSecond;
          void ExternalSubtitleTrack.load(source, fetchingSecond.signal)
            .then((loaded) => {
              if (secondWantedRef.current === source.id && loaded.count > 0) secondExternalRef.current = loaded;
            })
            .catch(() => {
              // Les lignes en mémoire sont complètes.
            });
        }
        const wanted = wantedSubtitleRef.current;
        if (!isGeneratingTrack(wanted) || generation.targetOf(wanted) !== target) return;
        // Sans à-coup : les lignes déjà reçues deviennent tout de suite la piste finale — même
        // position, même texte —, puis le fichier de Jellyfin les remplace s'il arrive. Attendre le
        // fichier aurait laissé un instant sans rien, et un échec, sans rien pour de bon.
        wantedSubtitleRef.current = source.id;
        setCurrentSubtitle(source.id);
        externalSubtitleRef.current = ExternalSubtitleTrack.fromCues(source.id, generation.cuesOf(target));
        setSubtitleIsNotice(false);
        subtitleFetchRef.current?.abort();
        const fetching = new AbortController();
        subtitleFetchRef.current = fetching;
        void ExternalSubtitleTrack.load(source, fetching.signal)
          .then((loaded) => {
            if (wantedSubtitleRef.current === source.id && loaded.count > 0) externalSubtitleRef.current = loaded;
          })
          .catch(() => {
            // Les lignes en mémoire sont complètes : rien à dire au spectateur.
          });
      },
      onFailed: (target) => {
        const second = secondWantedRef.current;
        if (isGeneratingTrack(second) && generation.targetOf(second) === target) clearSecond();
        const wanted = wantedSubtitleRef.current;
        if (!isGeneratingTrack(wanted) || generation.targetOf(wanted) !== target) return;
        wantedSubtitleRef.current = null;
        setCurrentSubtitle(null);
        setSubtitle(null);
        setSubtitleIsNotice(false);
      },
    });
  });
  // Ouverte avec l'hôte, fermée avec lui ; pas pendant un banc d'essai, qui mesure la lecture seule,
  // ni pour l'invité d'un lien de partage (§112) : jamais ouverte, elle ne demande pas ses options,
  // n'a aucune langue à proposer, et le menu « Générer » n'apparaît pas.
  useEffect(() => {
    if (bench || shareMode) return;
    void generation.open();
    return () => generation.close();
  }, [generation, bench, shareMode]);
  // Un sondage qui apporte des lignes (ou change d'état) redessine l'instant — film en pause compris,
  // où aucun `timeupdate` ne le ferait.
  useEffect(
    () =>
      generation.subscribe(() => {
        const element = videoElRef.current;
        const lane = generationLane();
        if (!element || !lane) return;
        if (lane === "second") {
          if (!secondExternalRef.current) showSecondGeneratedAt(element.currentTime - secondOffsetRef.current - fileDelayRef.current);
          return;
        }
        if (externalSubtitleRef.current) return;
        showGeneratedAt(element.currentTime - subtitleOffsetRef.current - fileDelayRef.current);
      }),
    [generation, generationLane, showGeneratedAt, showSecondGeneratedAt, externalSubtitleRef, fileDelayRef, secondExternalRef, secondOffsetRef, subtitleOffsetRef, videoElRef]
  );
  /** « Générer » dans le menu : la demande part, et l'entrée temporaire devient la piste choisie. */
  const requestGeneration = useCallback(
    (code: string) => {
      void generation.generate(code).then((id) => {
        if (id !== null) chooseSubtitle(id, externalsRef.current);
      });
    },
    [generation, chooseSubtitle, externalsRef]
  );
  /** « Générer — <langue> » comme second (§87) : la même demande, puis l'entrée devient le second. */
  const requestSecondGeneration = useCallback(
    (code: string) => {
      void generation.generate(code).then((id) => {
        if (id !== null) chooseSecond(id, externalsRef.current);
      });
    },
    [generation, chooseSecond, externalsRef]
  );
  return { requestGeneration, requestSecondGeneration };
}
