// Les deux voies de sous-titres du lecteur natif (`ExperimentalPlayerHost.tsx`) — le principal et le
// second (« Deux sous-titres », DECISIONS.md §87), fichiers à côté du film et générations (§70) :
// le choix d'une piste et la ligne à écrire à chaque instant. Sorti tel quel de l'hôte le 23/10/2026 ;
// l'état et les références restent déclarés dans l'hôte, qui les lit aussi, et passent ici.
import { useCallback, useRef, type Dispatch, type RefObject, type SetStateAction } from "react";
import type { useT } from "@/components/TranslationProvider";
import { isGeneratingTrack, type SubtitleGeneration } from "@/lib/subtitleGen/generation";
import type { RemuxPlayback } from "@/lib/webcodecs/remuxPlayback";
import { ExternalSubtitleTrack, isExternalTrack, type ExternalSubtitleSource } from "@/lib/webcodecs/externalSubtitles";
import { jellyfinSubtitleIndex, noticeText } from "@/components/player/nativeHostHelpers";
import { secondAllowed, secondSurvives } from "@/components/player/session/dualSubtitleRules";
import { cueLookupTime, isNeutralSync, startingOffset, type SubtitleSync } from "@/lib/subtitleSync";

/**
 * Les corrections de synchro appliquées à ce fichier (DECISIONS.md §141), telles que la description du fichier
 * les donne (`DirectPlayInfo.subtitleSync`, par index Jellyfin) — avec de quoi retrouver l'index d'une piste du
 * conteneur. `null` sans correction : tout se passe alors exactement comme avant.
 */
export interface NativeSubtitleSync {
  byIndex: Record<string, SubtitleSync>;
  embedded: number[] | undefined;
}

/**
 * La correction d'une piste choisie : `null` pour une génération, une piste sans correction, ou sans description.
 * Les pistes du conteneur sont demandées seulement s'il y a une correction (`fileTracks`, lu à la demande) : sans
 * correction, ce choix ne touche à rien de plus qu'avant.
 */
export function syncForChoice(
  id: number | null,
  held: NativeSubtitleSync | null,
  fileTracks: () => Parameters<typeof jellyfinSubtitleIndex>[1],
  sources: { id: number; url: string }[]
): SubtitleSync | null {
  if (id === null || !held || isGeneratingTrack(id)) return null;
  const index = jellyfinSubtitleIndex(id, fileTracks(), held.embedded, sources);
  const sync = index === null ? undefined : held.byIndex[String(index)];
  return sync && !isNeutralSync(sync) ? sync : null;
}

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
  subtitleScaleRef,
  secondScaleRef,
  subtitleSyncRef,
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
  /** L'échelle de la correction de chaque voie (§141) ; 1 sans correction. */
  subtitleScaleRef: RefObject<number>;
  secondScaleRef: RefObject<number>;
  subtitleSyncRef: RefObject<NativeSubtitleSync | null>;
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

  /**
   * La voie de l'aide d'un passage rejoué (§150) : une piste montrée à la place du principal le temps du
   * passage, sans rien choisir — ni `wantedSubtitleRef`, ni le pipeline, ni le menu. Ses propres références,
   * internes : rien d'autre que cette voie ne les lit.
   */
  const replayRef = useRef<{ id: number; offset: number; scale: number; external: ExternalSubtitleTrack | null } | null>(null);
  const replayFetchRef = useRef<AbortController | null>(null);

  /** Montre `id` sur la voie de l'aide ; `null` l'éteint, et le principal reprend à la ligne suivante. */
  const showReplay = useCallback(
    (id: number | null, sources: ExternalSubtitleSource[]) => {
      replayFetchRef.current?.abort();
      replayFetchRef.current = null;
      if (id === null) {
        if (replayRef.current) {
          replayRef.current = null;
          setSubtitle(null);
        }
        return;
      }
      // Calée comme si elle était choisie (§141) : sa correction à elle, jamais le décalage réglé sur le principal.
      const sync = syncForChoice(id, subtitleSyncRef.current, () => remuxRef.current?.subtitleTracks ?? [], sources);
      const lane = { id, offset: startingOffset(sync), scale: sync ? sync.scale : 1, external: null as ExternalSubtitleTrack | null };
      replayRef.current = lane;
      if (!isExternalTrack(id)) return;
      const source = sources.find((candidate) => candidate.id === id);
      if (!source) return;
      // Un fichier à côté du film : lu à la première aide, comme au choix. Un échec ne dit rien — l'aide n'est
      // qu'un plus, et le passage reste lisible sans elle.
      const fetching = new AbortController();
      replayFetchRef.current = fetching;
      void ExternalSubtitleTrack.load(source, fetching.signal)
        .then((loaded) => {
          if (replayRef.current === lane) lane.external = loaded;
        })
        .catch(() => {});
    },
    [remuxRef, setSubtitle, subtitleSyncRef]
  );

  /** Retire le second : un seul sous-titre. */
  const clearSecond = useCallback(() => {
    secondWantedRef.current = null;
    secondExternalRef.current = null;
    secondFetchRef.current?.abort();
    secondFetchRef.current = null;
    secondOffsetRef.current = 0;
    secondScaleRef.current = 1;
    setSecondOffset(0);
    setSecondSubtitle(null);
    setSecondText(null);
    setSecondIsNotice(false);
  }, [secondExternalRef, secondFetchRef, secondOffsetRef, secondScaleRef, secondWantedRef, setSecondIsNotice, setSecondOffset, setSecondSubtitle, setSecondText]);

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
      if (second !== null && !secondSurvives(id, second, isGeneratingTrack(id) && isGeneratingTrack(second))) clearSecond();
      wantedSubtitleRef.current = id;
      // Un décalage corrige une piste, pas la suivante. Une piste qu'un administrateur a recalée (§141) part
      // de sa correction — le spectateur peut encore l'ajuster ; toute autre part de zéro, comme avant.
      const sync = syncForChoice(id, subtitleSyncRef.current, () => remuxRef.current?.subtitleTracks ?? [], sources);
      const start = startingOffset(sync);
      subtitleOffsetRef.current = start;
      subtitleScaleRef.current = sync ? sync.scale : 1;
      setSubtitleOffset(start);
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
    [showWarning, generation, clearSecond, externalSubtitleRef, remuxRef, secondWantedRef, setCurrentSubtitle, setSubtitle, setSubtitleIsNotice, setSubtitleOffset, subtitleFetchRef, subtitleOffsetRef, subtitleScaleRef, subtitleSyncRef, tRef, wantedSubtitleRef]
  );

  /**
   * Choisit le second sous-titre (§87) — même chemin que le principal : une piste du fichier se lit
   * dans les lignes déjà recueillies, un fichier à côté du film se télécharge au choix, une entrée
   * « … génération… » s'active. Jamais le principal lui-même, jamais une seconde génération.
   */
  const chooseSecond = useCallback(
    (id: number | null, sources: ExternalSubtitleSource[]) => {
      const primary = wantedSubtitleRef.current;
      if (!secondAllowed(id, primary)) return;
      const generating = isGeneratingTrack(id);
      if (generating && isGeneratingTrack(primary)) return;
      clearSecond();
      secondWantedRef.current = id;
      setSecondSubtitle(id);
      // Le second part de sa correction comme le principal (§141).
      const sync = syncForChoice(id, subtitleSyncRef.current, () => remuxRef.current?.subtitleTracks ?? [], sources);
      if (sync) {
        const start = startingOffset(sync);
        secondOffsetRef.current = start;
        secondScaleRef.current = sync.scale;
        setSecondOffset(start);
      }
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
    [showWarning, generation, clearSecond, remuxRef, secondExternalRef, secondFetchRef, secondOffsetRef, secondScaleRef, secondWantedRef, setSecondOffset, setSecondSubtitle, subtitleSyncRef, tRef, wantedSubtitleRef]
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
      // La recherche de ligne passe par `cueLookupTime` (§141) : à l'échelle 1, le calcul d'avant à l'identique.
      const offset = secondOffsetRef.current;
      const scale = secondScaleRef.current;
      setSecondText(
        isExternalTrack(id)
          ? (secondExternalRef.current?.textAt(cueLookupTime(playerSeconds, fileDelay, offset, scale, true)) ?? null)
          : fromContainer(cueLookupTime(playerSeconds, fileDelay, offset, scale, false), id)
      );
    },
    [generationLane, showSecondGeneratedAt, secondExternalRef, secondOffsetRef, secondScaleRef, secondWantedRef, setSecondIsNotice, setSecondText]
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
      // L'aide d'un passage rejoué (§150) prend la place du principal — une forcée, ou rien — le temps du passage.
      const replay = replayRef.current;
      if (replay) {
        setSubtitleIsNotice(false);
        setSubtitle(
          isExternalTrack(replay.id)
            ? (replay.external?.textAt(cueLookupTime(playerSeconds, fileDelay, replay.offset, replay.scale, true)) ?? null)
            : fromContainer(cueLookupTime(playerSeconds, fileDelay, replay.offset, replay.scale, false), replay.id)
        );
        return;
      }
      // Une génération est datée comme un fichier à côté du film : sur l'horloge du fichier. Celle du
      // principal seulement : une génération affichée par le second ne remplace pas le principal (§87).
      if (!external && generationLane() === "primary") {
        showGeneratedAt(at - fileDelay);
        return;
      }
      setSubtitleIsNotice(false);
      // Un fichier à côté du film est daté sur l'horloge du fichier, pas sur celle du lecteur. La correction
      // d'une piste recalée (§141) s'applique ici : `cueLookupTime`, qui à l'échelle 1 refait le calcul d'avant.
      const offset = subtitleOffsetRef.current;
      const scale = subtitleScaleRef.current;
      setSubtitle(
        external
          ? external.textAt(cueLookupTime(playerSeconds, fileDelay, offset, scale, true))
          : fromContainer(cueLookupTime(playerSeconds, fileDelay, offset, scale, false))
      );
    },
    [generationLane, showGeneratedAt, showSecondAt, externalSubtitleRef, fileDelayRef, setSubtitle, setSubtitleIsNotice, subtitleOffsetRef, subtitleScaleRef]
  );

  return { generationLane, clearSecond, chooseSubtitle, chooseSecond, showGeneratedAt, showSecondGeneratedAt, showSubtitleAt, showReplay };
}
