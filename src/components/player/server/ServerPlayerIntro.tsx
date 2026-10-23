"use client";

import { useEffect, useState, type RefObject } from "react";
import type { usePlayback } from "@/components/PlaybackProvider";
import { useT } from "@/components/TranslationProvider";
import { PlaybackIntro, type IntroPhase } from "@/components/player/PlaybackIntro";
import { finishIntro, introAllowedFor, introCaption, introFinished, introKey, startIntroClock } from "@/lib/playbackIntro";
import { useServerIntroPicture } from "@/lib/introEnd";

/**
 * L'ouverture, côté lecteur serveur : la même que celle du lecteur natif, et — quand il prend la
 * relève avant la première image — la même *instance visuelle* : l'horloge posée à l'appui la fait
 * reprendre au point où l'autre en était (`startIntroClock`), sans rejouer son apparition.
 *
 * Décidée au montage, comme chez le natif : une lecture qui a déjà montré une image — un relais en
 * plein film, une diffusion — n'en a pas. Ni une séance qui existe pour diffuser (`allowed`).
 */
export function ServerPlayerIntro({
  session,
  allowed,
  loading,
  trouble,
  hidden,
  resumeSeconds,
  videoRef,
  onCoverChange,
  note,
  onClose,
}: {
  session: NonNullable<ReturnType<typeof usePlayback>["session"]>;
  /** Le mot d'une attente longue (« toujours en cours… »), dit sous la ligne de l'ouverture. */
  note?: string | null;
  /** Le calque couvre-t-il le lecteur — l'hôte en tait la roue et le fil de ses commandes. */
  onCoverChange?: (covering: boolean) => void;
  allowed: boolean;
  /** Pas encore d'image : `loading` de ce lecteur, qui tombe à `loadeddata`. */
  loading: boolean;
  trouble: boolean;
  hidden: boolean;
  resumeSeconds: number | null;
  videoRef: RefObject<HTMLVideoElement | null>;
  onClose: () => void;
}) {
  const t = useT();
  const key = introKey(session.openId, session.itemId);
  const [eligible] = useState(() => allowed && introAllowedFor(session) && !introFinished(key));
  const [startedAt] = useState(() => startIntroClock(key));
  // Une image a été montrée : l'ouverture est finie pour cette lecture, quoi qu'il arrive ensuite
  // (un nouvel essai, un changement de piste remettent `loading` — ce n'est plus une ouverture).
  //
  // `loading` tombe à `loadeddata`, c'est-à-dire *avant* le saut vers la position de reprise : une
  // reprise laissait ~3 s d'écran noir entre l'ouverture effacée et l'image (vu en capture le
  // 10/10/2026, Forrest Gump repris à 21 min). L'image compte donc quand l'élément en a une à sa
  // position actuelle — plus de saut en cours, `readyState` ≥ 2 —, attendue par ses événements.
  const pictured = useServerIntroPicture(loading, videoRef);
  useEffect(() => {
    if (pictured) finishIntro(key);
  }, [pictured, key]);
  const phase: IntroPhase = !eligible || hidden ? "gone" : pictured ? "picture" : trouble ? "gone" : "waiting";
  if (phase === "gone") return null;
  return (
    <PlaybackIntro
      phase={phase}
      startedAt={startedAt}
      clockKey={key}
      art={session.introArt ?? null}
      // Ici l'image et la fin ne font qu'un (`useServerIntroPicture`) : l'ouverture posée au montage
      // s'efface sur elle — même règle que chez le natif.
      imageShown={pictured}
      onCoverChange={onCoverChange}
      fallbackName={session.title}
      caption={introCaption({ ...session.introArt, resumeSeconds }, t)}
      note={note ?? null}
      onClose={onClose}
      closeLabel={t("common.close")}
      className="absolute inset-0 z-[25]"
    />
  );
}
