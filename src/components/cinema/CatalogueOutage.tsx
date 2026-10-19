"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useSWRConfig } from "swr";
import { useLocale, useT } from "@/components/TranslationProvider";
import { useToast } from "@/components/Toast";
import { MOVIES_CATALOGUE_KEY, SERIES_CATALOGUE_KEY } from "@/lib/swr";
import { errorMessage } from "@/lib/upstreamError";
import { SlowLaunchDownloads } from "@/components/offline/SlowLaunchDownloads";
import {
  needsOutageRefresh,
  notePlaybackOutage,
  onPlayBlockedByOutage,
  outageOf,
  OUTAGE_REFRESH_MS,
  type CatalogueOutage,
  type OutageMarks,
} from "@/lib/catalogueOutage";

/**
 * Le cinéma pendant une panne de Jellyfin, pour le bureau et le téléphone (14/10/2026, DECISIONS.md
 * §92). Une seule écriture des trois pièces — le crochet, le bandeau, l'écran sans catalogue — pour
 * que les deux accueils ne puissent pas diverger : ils n'en décident que la place.
 *
 * Sobre, comme demandé : noir et blanc, textes atténués, aucune couleur d'état. Une panne
 * passagère n'est pas une alarme, et le texte suffit.
 */

/** Relance les deux catalogues : le bouton Réessayer, l'essai automatique, un appui refusé. */
function useRetryCatalogue(): () => Promise<void> {
  const { mutate } = useSWRConfig();
  return useCallback(async () => {
    // `mutate` de la configuration : il relit par le premier crochet inscrit (`revalidators[0]`).
    await Promise.all([mutate(MOVIES_CATALOGUE_KEY), mutate(SERIES_CATALOGUE_KEY)]).catch(() => undefined);
  }, [mutate]);
}

/**
 * L'état de panne d'après les catalogues tenus, transmis au bouton Lecture (`PlaybackProvider.play`
 * le consulte) — avec le message à dire quand un appui est refusé. À démonter, la panne n'est plus
 * l'affaire de personne : la gestion ne doit pas hériter d'un refus que rien n'y expliquerait.
 */
export function useCatalogueOutage(...payloads: (OutageMarks | null | undefined)[]): CatalogueOutage {
  const outage = outageOf(...payloads);
  const t = useT();
  const toast = useToast();
  const retry = useRetryCatalogue();
  useEffect(() => {
    notePlaybackOutage(outage.jellyfinDown);
  }, [outage.jellyfinDown]);
  // Tant que le catalogue est marqué : une relecture toutes les 30 s, page visible seulement — le
  // bandeau part seul au retour de Jellyfin, sans recharger. Rien en temps normal.
  const refresh = needsOutageRefresh(outage);
  useEffect(() => {
    if (!refresh) return;
    const timer = setInterval(() => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      void retry();
    }, OUTAGE_REFRESH_MS);
    return () => clearInterval(timer);
  }, [refresh, retry]);
  // Le message et la relecture lus par référence : l'écouteur est posé une fois, au montage, et le
  // drapeau n'est remis à faux qu'au démontage. Avec `[t, toast, retry]` en dépendances, le premier
  // refus affichait un toast, le fournisseur se redessinait avec une valeur neuve, l'effet repartait
  // — et son nettoyage remettait la panne à faux : le second appui ouvrait le lecteur sur un Jellyfin
  // mort (relecture du 14/10/2026). Un toast quelconque pendant la panne faisait de même.
  const blockedRef = useRef<() => void>(() => undefined);
  useEffect(() => {
    blockedRef.current = () => {
      toast.info(t("cinema.outage.playBlocked"));
      // Et une relecture tout de suite : si Jellyfin est revenu, le bandeau part et l'appui suivant passe.
      void retry();
    };
  }, [t, toast, retry]);
  useEffect(() => {
    onPlayBlockedByOutage(() => blockedRef.current());
    return () => {
      onPlayBlockedByOutage(null);
      notePlaybackOutage(false);
    };
  }, []);
  return outage;
}

/** Le bandeau discret : rien quand Jellyfin répond. */
export function CatalogueOutageBanner({ outage, className = "" }: { outage: CatalogueOutage; className?: string }) {
  const t = useT();
  if (!outage.jellyfinDown) return null;
  return (
    <p role="status" data-testid="catalogue-outage-banner" className={`text-xs ${className}`}>
      {/* Un bloc et non un texte en ligne : sur téléphone la phrase passe à la ligne, et un fond posé
          sur une ligne coupée se découpait en deux morceaux. Sombre et opaque : sur le visuel clair
          d'une bannière, un voile à 8 % ne se lisait plus. */}
      <span className="inline-block max-w-full rounded-2xl bg-ink/85 px-3 py-1.5 leading-snug text-white">{t("cinema.outage.banner")}</span>
    </p>
  );
}

/**
 * L'écran sans catalogue (aucun n'a jamais été gardé pour ce compte) : ce qui manque, un bouton
 * Réessayer, et un essai automatique annoncé. `children` porte ce que l'appelant ajoute — le
 * « Mode standard » de l'administrateur sur le bureau.
 */
export function CatalogueUnavailable({ error, children }: { error: unknown; children?: ReactNode }) {
  const t = useT();
  const { locale } = useLocale();
  const retry = useRetryCatalogue();
  const seconds = Math.round(OUTAGE_REFRESH_MS / 1000);
  const [left, setLeft] = useState(seconds);
  const [busy, setBusy] = useState(false);

  const run = useCallback(() => {
    setBusy(true);
    void retry().finally(() => {
      setBusy(false);
      setLeft(seconds);
    });
  }, [retry, seconds]);

  // Le compte à rebours, une seconde à la fois, et l'essai à zéro. En pause pendant un essai.
  useEffect(() => {
    if (busy) return;
    const timer = setInterval(() => {
      setLeft((n) => (n > 1 ? n - 1 : 0));
    }, 1000);
    return () => clearInterval(timer);
  }, [busy]);
  useEffect(() => {
    if (left !== 0 || busy) return;
    // Différé d'un tour : l'essai change l'état, pas pendant l'effet lui-même.
    const timer = setTimeout(run, 0);
    return () => clearTimeout(timer);
  }, [left, busy, run]);

  return (
    <div data-testid="catalogue-unavailable" className="flex flex-col items-center gap-4 text-center">
      <p className="max-w-sm text-sm text-white">{errorMessage(error, t, t("errors.loadFailed"), locale)}</p>
      <div className="flex flex-wrap items-center justify-center gap-3">
        <button type="button" className="btn-primary" onClick={run} disabled={busy}>
          {busy ? t("cinema.outage.retrying") : t("cinema.outage.retry")}
        </button>
        {children}
        {/* Le serveur ne répond plus : les téléchargements de l'appareil, s'il y en a (§109). */}
        <SlowLaunchDownloads delayMs={0} placement="inline" />
      </div>
      <p className="text-xs text-subtle" aria-live="polite">
        {busy ? t("cinema.outage.retrying") : t("cinema.outage.nextRetry", { n: String(left) })}
      </p>
    </div>
  );
}
