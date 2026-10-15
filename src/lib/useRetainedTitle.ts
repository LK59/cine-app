"use client";

import { useEffect, useRef, useState } from "react";
import { useToast } from "@/components/Toast";
import { useT } from "@/components/TranslationProvider";
import { noteRetiredSheet, onPlayBlockedByRetired } from "@/lib/retiredTitle";

/**
 * Le titre d'une fiche ouverte, gardé quand il quitte le catalogue sous elle — bureau et téléphone
 * (15/10/2026, DECISIONS.md §94).
 *
 * Les fiches se résolvent par l'adresse (`film=12`) dans le catalogue tenu. Relu au retour au
 * premier plan, le catalogue peut ne plus contenir ce titre : la fiche se serait démontée d'un coup
 * sous les yeux, puis le filet (`useRepairUnresolvedSheet`) aurait dit « pas encore disponible » et
 * rendu l'adresse. Elle reste : le dernier titre résolu pour **cette même demande** est rendu, marqué
 * `retired`. Une autre demande (une autre adresse) repart de zéro — un lien vers un titre absent
 * reste l'affaire du filet. Un titre revenu au catalogue redevient le sien.
 */
export function useRetainedTitle<T>(requested: string | null, live: T | null): { item: T | null; retired: boolean } {
  const [kept, setKept] = useState<{ requested: string; item: T } | null>(null);
  if (requested !== null && live !== null && (kept?.requested !== requested || kept.item !== live)) {
    setKept({ requested, item: live });
  }
  if (live !== null) return { item: live, retired: false };
  if (requested !== null && kept?.requested === requested) return { item: kept.item, retired: true };
  return { item: null, retired: false };
}

/**
 * Le bouton Lecture d'une fiche de titre retiré : refusé par `PlaybackProvider.play`
 * (`playBlockedByRetired`), avec un message — rien ne s'ouvre, rien ne plante. Le message est lu par
 * référence et l'écouteur posé une fois, pour la raison de `useCatalogueOutage` : un toast redessine
 * le fournisseur, et un effet qui repartait aurait levé le refus.
 */
export function useRetiredTitleGuard(retired: boolean): void {
  const t = useT();
  const toast = useToast();
  useEffect(() => {
    noteRetiredSheet(retired);
  }, [retired]);
  const say = useRef<() => void>(() => undefined);
  useEffect(() => {
    say.current = () => toast.info(t("cinema.titleRetired"));
  }, [t, toast]);
  useEffect(() => {
    onPlayBlockedByRetired(() => say.current());
    return () => {
      onPlayBlockedByRetired(null);
      noteRetiredSheet(false);
    };
  }, []);
}
