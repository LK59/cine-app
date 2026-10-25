"use client";

import { useEffect, useState } from "react";
import useSWR from "swr";
import { usePlaybackMode } from "@/components/PlaybackProvider";
import { fetcher } from "@/lib/swr";
import { passageFlags, registerPassageOpener } from "@/lib/passage/client";
import { isInstalledApp } from "@/lib/iosInstall";
import { PassageScreen } from "./PassageScreen";

/**
 * Le passage vers la nouvelle adresse, sur l'ancienne (DECISIONS.md §119) : un écran plein, sans croix
 * (`PassageScreen`, 25/10/2026). Il a remplacé un bandeau qu'on refermait — deux jours plus tard, des
 * comptes passés rouvraient encore l'ancienne icône, d'autres n'avaient jamais essayé. Dans un onglet,
 * un gros bouton qui connecte à la nouvelle adresse ; dans l'application installée, les étapes pour
 * installer la nouvelle et supprimer celle-ci.
 *
 * Seulement quand l'installation annonce une nouvelle adresse (`GET /api/passage`, tiré du réglage
 * du déploiement) — et donc rien sans réseau : les téléchargements de l'ancienne restent lisibles hors
 * connexion —, jamais sur la nouvelle elle-même (l'hôte de la page comparé à celui de la destination),
 * jamais pendant un film (le lecteur ouvert, plein écran ou réduit) ni par-dessus l'écran d'accueil
 * d'un premier lancement. Les clés de fermeture du bandeau des 10.0.x sont effacées
 * (`passageFlags.forgetBannerClosed`).
 *
 * Le lien « nouvelle adresse » de la page Nouveautés (`openPassageFor`) est pris en charge tant que
 * l'écran est là : c'est lui, le passage.
 */
export function PassageBanner() {
  const mode = usePlaybackMode();
  const { data } = useSWR<{ target: string | null }>("/api/passage", fetcher, { revalidateOnFocus: false });
  // Pas par-dessus l'écran d'accueil d'un premier lancement, comme l'invitation aux notifications.
  const { data: onboarding } = useSWR<{ pending?: boolean }>("/api/onboarding", fetcher, { revalidateOnFocus: false });
  // Lu une fois : monté sans rendu serveur (`PlayerShell`), l'adresse de la page ne change pas.
  const [here] = useState(() => (typeof window === "undefined" ? "" : window.location.host));
  const [installed] = useState(() => isInstalledApp());

  const target = data?.target ?? null;
  let targetHost: string | null = null;
  try {
    targetHost = target ? new URL(target).host : null;
  } catch {
    targetHost = null;
  }
  // Sur la nouvelle adresse, rien : on y est déjà.
  const elsewhere = targetHost !== null && here !== "" && here !== targetHost;

  useEffect(() => {
    passageFlags.forgetBannerClosed();
  }, []);

  const shown = elsewhere && target !== null && mode === "closed" && onboarding?.pending !== true;

  useEffect(() => {
    if (!shown || !targetHost) return;
    registerPassageOpener((link) => {
      try {
        return new URL(link).host === targetHost;
      } catch {
        return false;
      }
    });
    return () => registerPassageOpener(null);
  }, [shown, targetHost]);

  if (!shown || !target) return null;
  return <PassageScreen target={target} installed={installed} />;
}
