"use client";

import useSWR from "swr";
import { fetcher, playerBootstrapOptions } from "@/lib/swr";
import { useT } from "@/components/TranslationProvider";

/**
 * Cette page tourne-t-elle sur l'**ancienne** adresse d'une installation qui en annonce une nouvelle
 * (`passageHost`, DECISIONS.md §119) ?
 *
 * Toute aide « Ajouter à l'écran d'accueil » s'y tait : elle pousserait à installer — ou réinstaller —
 * l'adresse qu'on quitte (relecture du 23/10/2026). Sur la nouvelle adresse, et sur une installation
 * sans nouvelle adresse, rien ne change.
 */
export function isOldAddress(passageHost: string | null | undefined, host: string): boolean {
  return !!passageHost && passageHost.toLowerCase() !== host.toLowerCase();
}

/**
 * `old` : `true` sur l'ancienne adresse, `false` ailleurs ou si la configuration ne répond pas (rien
 * ne change alors), `null` tant qu'on ne sait pas — l'appelant attend avant de montrer son aide.
 * `host` : la nouvelle adresse, pour la nommer.
 *
 * `/api/config/public` est public (la page de connexion s'en sert) et déjà demandé par le lecteur ;
 * `playerBootstrapOptions` pour qu'un film en plein écran ne fasse pas abandonner la requête.
 */
export function useOldAddress(): { old: boolean | null; host: string | null } {
  const { data, error } = useSWR<{ passageHost?: string | null }>("/api/config/public", fetcher, playerBootstrapOptions);
  if (error) return { old: false, host: null };
  if (!data) return { old: null, host: null };
  const host = data.passageHost ?? null;
  return { old: typeof window !== "undefined" && isOldAddress(host, window.location.host), host };
}

/**
 * La phrase « sur iPhone, ajoutez d'abord l'application à l'écran d'accueil » des notifications
 * (`PushToggle`, accueil du compte) — et, sur l'ancienne adresse, celle qui renvoie à la nouvelle au
 * lieu de faire installer celle-ci. Une seule décision pour les deux endroits.
 */
export function useInstallHintText(): string {
  const t = useT();
  const { old, host } = useOldAddress();
  return old && host ? t("player.onboarding.notifInstallElsewhere", { host }) : t("player.onboarding.notifInstall");
}
