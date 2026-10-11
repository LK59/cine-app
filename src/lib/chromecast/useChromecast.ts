"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { chromecastSenderEligible } from "./eligible";
import { chromecastConfig, chromecastServerSnapshot, chromecastSnapshot, startChromecastSender, subscribeChromecast, type ChromecastSnapshot } from "./framework";

/**
 * Le Chromecast peut-il être proposé ici ? — DECISIONS.md §64.
 *
 * Trois conditions, et toutes : le choix de l'appelant (`allowed` : un lecteur serveur existe, la
 * séance n'est pas un banc d'essai), un navigateur qui sait émettre (`chromecastSenderEligible`), et
 * la réponse de l'installation pour ce compte (`/api/player/cast` : administrateurs, ou tous les
 * comptes si `CHROMECAST_FOR_EVERYONE`). Fausse tant qu'on ne sait pas — le sens prudent : un bouton
 * qui apparaît vaut mieux qu'un bouton qui disparaît.
 *
 * L'installation n'est interrogée que d'un navigateur qui sait émettre : un iPhone ne demande rien.
 */
export function useChromecastAllowed(allowed: boolean): boolean {
  const [granted, setGranted] = useState(false);
  useEffect(() => {
    if (!allowed || !chromecastSenderEligible(navigator.userAgent)) return;
    let cancelled = false;
    void chromecastConfig().then((answer) => {
      if (!cancelled) setGranted(answer.allowed);
    });
    return () => {
      cancelled = true;
    };
  }, [allowed]);
  return allowed && granted;
}

/**
 * L'état partagé du Chromecast pour cette page, et le chargement du kit quand `enabled` le permet.
 *
 * Désactivé, rien ne se charge et l'état reste « éteint » ; activé, le kit de Google est chargé une
 * fois pour toute la page (`startChromecastSender`).
 */
export function useChromecast(enabled: boolean): ChromecastSnapshot {
  const state = useSyncExternalStore(subscribeChromecast, chromecastSnapshot, chromecastServerSnapshot);
  useEffect(() => {
    if (enabled) void startChromecastSender();
  }, [enabled]);
  return state;
}
