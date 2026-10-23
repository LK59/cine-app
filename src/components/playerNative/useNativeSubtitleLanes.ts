// Les deux voies de sous-titres du lecteur natif (`ExperimentalPlayerHost.tsx`) — le principal et le
// second (« Deux sous-titres », DECISIONS.md §87), fichiers à côté du film et générations (§70) :
// le choix d'une piste et la ligne à écrire à chaque instant. Sorti tel quel de l'hôte le 23/10/2026 ;
// l'état et les références restent déclarés dans l'hôte, qui les lit aussi, et passent ici.
import { useCallback, type Dispatch, type RefObject, type SetStateAction } from "react";
import type { useT } from "@/components/TranslationProvider";
import { isGeneratingTrack, type SubtitleGeneration } from "@/lib/subtitleGen/generation";
import type { RemuxPlayback } from "@/lib/webcodecs/remuxPlayback";
import { ExternalSubtitleTrack, isExternalTrack, type ExternalSubtitleSource } from "@/lib/webcodecs/externalSubtitles";
import { noticeText } from "@/components/player/nativeHostHelpers";

export function useNativeSubtitleLanes({
  generation,
  wantedSubtitleRef,
  secondWantedRef,
  secondExternalRef,
  secondFetchRef,
  secondOffsetRef,
  setSecondOffset,
  setSecondSubtitle,
  setSecondText,
  setSecondIsNotice,
  subtitleOffsetRef,
  setSubtitleOffset,
  setCurrentSubtitle,
  setSubtitle,
  remuxRef,
  externalSubtitleRef,
  setSubtitleIsNotice,
  subtitleFetchRef,
  showWarning,
  tRef,
  fileDelayRef,
}: {
  generation: SubtitleGeneration;
  wantedSubtitleRef: RefObject<number | null>;
  secondWantedRef: RefObject<number | null>;
  secondExternalRef: RefObject<ExternalSubtitleTrack | null>;
  secondFetchRef: RefObject<AbortController | null>;
  secondOffsetRef: RefObject<number>;
  setSecondOffset: Dispatch<SetStateAction<number>>;
  setSecondSubtitle: Dispatch<SetStateAction<number | null>>;
  setSecondText: Dispatch<SetStateAction<string | null>>;
  setSecondIsNotice: Dispatch<SetStateAction<boolean>>;
  subtitleOffsetRef: RefObject<number>;
  setSubtitleOffset: Dispatch<SetStateAction<number>>;
  setCurrentSubtitle: Dispatch<SetStateAction<number | null>>;
  setSubtitle: Dispatch<SetStateAction<string | null>>;
  remuxRef: RefObject<RemuxPlayback | null>;
  externalSubtitleRef: RefObject<ExternalSubtitleTrack | null>;
  setSubtitleIsNotice: Dispatch<SetStateAction<boolean>>;
  subtitleFetchRef: RefObject<AbortController | null>;
  showWarning: (text: string | null) => void;
  tRef: RefObject<ReturnType<typeof useT>>;
  fileDelayRef: RefObject<number>;
}) {
  /**
   * Quelle voie porte la génération active : une seule génération est sondée et dessinée à la fois
   * (`SubtitleGeneration.activate`), le principal ou le second. `null` : aucune des deux.
   */
  const generationLane = useCallback((): "primary" | "second" | null => {
    const active = generation.activeTarget;
    if (!active) return null;
    const primary = wantedSubtitleRef.current;
    if (isGeneratingTrack(primary) && generation.targetOf(primary) === active) return "primary";
    const second = secondWantedRef.current;
    if (isGeneratingTrack(second) && generation.targetOf(second) === active) return "second";
    return null;
  }, [generation, secondWantedRef, wantedSubtitleRef]);

  /** Retire le second : un seul sous-titre. */
  const clearSecond = useCallback(() => {
    secondWantedRef.current = null;
    secondExternalRef.current = null;
    secondFetchRef.current?.abort();
    secondFetchRef.current = null;
    secondOffsetRef.current = 0;
    setSecondOffset(0);
    setSecondSubtitle(null);
    setSecondText(null);
    setSecondIsNotice(false);
  }, [secondExternalRef, secondFetchRef, secondOffsetRef, secondWantedRef, setSecondIsNotice, setSecondOffset, setSecondSubtitle, setSecondText]);

  /**
   * Chooses a subtitle, from the menu or from the viewer's account — a track of the file, told to
   * the pipeline, or a file beside the film, fetched here.
   */
  const chooseSubtitle = useCallback(
    (id: number | null, sources: ExternalSubtitleSource[]) => {
      // Le second ne survit pas à un principal éteint (un seul sous-titre, ou aucun), ni à devenir
      // lui-même le principal (les commandes rendent alors l'ancien principal comme second), ni à une
      // seconde génération : une seule est dessinée à la fois (§87).
      const second = secondWantedRef.current;
      if (second !== null && (id === null || id === second || (isGeneratingTrack(id) && isGeneratingTrack(second)))) clearSecond();
      wantedSubtitleRef.current = id;
      // Un décalage corrige une piste, pas la suivante.
      subtitleOffsetRef.current = 0;
      setSubtitleOffset(0);
      setCurrentSubtitle(id);
      setSubtitle(null);

      // Whichever is chosen, the other is turned off first: the pipeline showing a track from
      // the container and a file showing its own would both write the same line.
      const external = id !== null && isExternalTrack(id);
      remuxRef.current?.selectSubtitleTrack(external ? null : id);

      // Retiré tout de suite, y compris pour un autre fichier : l'ancien restait affiché pendant le
      // chargement du nouveau, et pour de bon si ce chargement échouait — du français sous un menu
      // qui disait anglais (relu le 24/09/2026).
      externalSubtitleRef.current = null;
      setSubtitleIsNotice(false);
      // Une entrée « … génération… » : ses lignes viennent du sondage, pas d'un fichier. Toute
      // autre piste arrête de sonder — on ne sonde que ce que le spectateur regarde.
      const generating = isGeneratingTrack(id);
      // Une génération que le second affiche reste sondée quand le principal change (§87).
      generation.activate(generating ? id : isGeneratingTrack(secondWantedRef.current) ? secondWantedRef.current : null);
      // Un fichier encore en vol est abandonné quel que soit le nouveau choix — piste du film,
      // aucun sous-titre ou génération compris, pas seulement un autre fichier : sinon son échec
      // tardif affichait « sous-titres indisponibles » pour un fichier que le spectateur avait
      // quitté (relevé le 22/10/2026).
      subtitleFetchRef.current?.abort();
      subtitleFetchRef.current = null;
      if (!external || generating) return;
      const source = sources.find((candidate) => candidate.id === id);
      if (!source) return;
      // Fetched on being chosen rather than up front: a film may carry half a dozen of these
      // and the viewer will read one of them.
      const fetching = new AbortController();
      subtitleFetchRef.current = fetching;
      void ExternalSubtitleTrack.load(source, fetching.signal)
        .then((loaded) => {
          // Unless the viewer has moved on while it was in flight.
          if (wantedSubtitleRef.current === id) externalSubtitleRef.current = loaded;
        })
        .catch(() => {
          // An abandoned fetch is not a failure to report: the viewer asked for something else,
          // or closed the film.
          if (!fetching.signal.aborted) showWarning(tRef.current("player.experimental.externalSubtitlesUnavailable"));
        });
    },
    [showWarning, generation, clearSecond, externalSubtitleRef, remuxRef, secondWantedRef, setCurrentSubtitle, setSubtitle, setSubtitleIsNotice, setSubtitleOffset, subtitleFetchRef, subtitleOffsetRef, tRef, wantedSubtitleRef]
  );

  /**
   * Choisit le second sous-titre (§87) — même chemin que le principal : une piste du fichier se lit
   * dans les lignes déjà recueillies, un fichier à côté du film se télécharge au choix, une entrée
   * « … génération… » s'active. Jamais le principal lui-même, jamais une seconde génération.
   */
  const chooseSecond = useCallback(
    (id: number | null, sources: ExternalSubtitleSource[]) => {
      const primary = wantedSubtitleRef.current;
      if (id !== null && (id === primary || primary === null)) return;
      const generating = isGeneratingTrack(id);
      if (generating && isGeneratingTrack(primary)) return;
      clearSecond();
      secondWantedRef.current = id;
      setSecondSubtitle(id);
      generation.activate(generating ? id : isGeneratingTrack(primary) ? primary : null);
      if (id === null || generating || !isExternalTrack(id)) return;
      const source = sources.find((candidate) => candidate.id === id);
      if (!source) return;
      const fetching = new AbortController();
      secondFetchRef.current = fetching;
      void ExternalSubtitleTrack.load(source, fetching.signal)
        .then((loaded) => {
          if (secondWantedRef.current === id) secondExternalRef.current = loaded;
        })
        .catch(() => {
          if (!fetching.signal.aborted) showWarning(tRef.current("player.experimental.externalSubtitlesUnavailable"));
        });
    },
    [showWarning, generation, clearSecond, secondExternalRef, secondFetchRef, secondWantedRef, setSecondSubtitle, tRef, wantedSubtitleRef]
  );

  /**
   * Ce qu'une génération en cours écrit à cet instant (horloge du fichier) : sa ligne, ou — dans
   * une zone pas encore traduite seulement — un message d'état, au même endroit et du même style
   * (DECISIONS.md §70). Jamais les deux : un message ne remplace qu'un vide.
   */
  const generatedAt = useCallback(
    (fileSeconds: number): { text: string | null; notice: boolean } => {
      const text = generation.textAt(fileSeconds);
      if (text) {
        generation.noteShown();
        return { text, notice: false };
      }
      const notice = generation.noticeAt(fileSeconds);
      return { text: notice ? noticeText(notice, tRef.current) : null, notice: notice !== null };
    },
    [generation, tRef]
  );
  const showGeneratedAt = useCallback(
    (fileSeconds: number) => {
      const shown = generatedAt(fileSeconds);
      setSubtitleIsNotice(shown.notice);
      setSubtitle(shown.text);
    },
    [generatedAt, setSubtitle, setSubtitleIsNotice]
  );
  /** La même chose sur la voie du second (§87) : ses messages d'état s'écrivent à sa place à lui. */
  const showSecondGeneratedAt = useCallback(
    (fileSeconds: number) => {
      const shown = generatedAt(fileSeconds);
      setSecondIsNotice(shown.notice);
      setSecondText(shown.text);
    },
    [generatedAt, setSecondIsNotice, setSecondText]
  );

  /**
   * La ligne du second à cet instant, sur sa propre horloge — son décalage à lui, et celle du fichier
   * pour ce qui vient d'à côté du film, comme le principal.
   */
  const showSecondAt = useCallback(
    (playerSeconds: number, fromContainer: (at: number, track?: number) => string | null, fileDelay: number) => {
      const id = secondWantedRef.current;
      if (id === null) {
        setSecondText(null);
        setSecondIsNotice(false);
        return;
      }
      const at = playerSeconds - secondOffsetRef.current;
      if (isGeneratingTrack(id)) {
        if (generationLane() === "second") showSecondGeneratedAt(at - fileDelay);
        else {
          setSecondText(null);
          setSecondIsNotice(false);
        }
        return;
      }
      setSecondIsNotice(false);
      setSecondText(isExternalTrack(id) ? (secondExternalRef.current?.textAt(at - fileDelay) ?? null) : fromContainer(at, id));
    },
    [generationLane, showSecondGeneratedAt, secondExternalRef, secondOffsetRef, secondWantedRef, setSecondIsNotice, setSecondText]
  );

  /**
   * What to write under the picture at this instant.
   *
   * An external file, once chosen, is the only source: the pipeline was told to show nothing, so
   * asking it would only ever produce null, and letting it answer at all would mean two sources
   * racing to set the same line.
   */
  const showSubtitleAt = useCallback(
    (playerSeconds: number, fromContainer: (at: number, track?: number) => string | null, fileDelay = 0) => {
      const at = playerSeconds - subtitleOffsetRef.current;
      const external = externalSubtitleRef.current;
      fileDelayRef.current = fileDelay;
      showSecondAt(playerSeconds, fromContainer, fileDelay);
      // Une génération est datée comme un fichier à côté du film : sur l'horloge du fichier. Celle du
      // principal seulement : une génération affichée par le second ne remplace pas le principal (§87).
      if (!external && generationLane() === "primary") {
        showGeneratedAt(at - fileDelay);
        return;
      }
      setSubtitleIsNotice(false);
      // Un fichier à côté du film est daté sur l'horloge du fichier, pas sur celle du lecteur.
      setSubtitle(external ? external.textAt(at - fileDelay) : fromContainer(at));
    },
    [generationLane, showGeneratedAt, showSecondAt, externalSubtitleRef, fileDelayRef, setSubtitle, setSubtitleIsNotice, subtitleOffsetRef]
  );

  return { generationLane, clearSecond, chooseSubtitle, chooseSecond, showGeneratedAt, showSecondGeneratedAt, showSubtitleAt };
}
