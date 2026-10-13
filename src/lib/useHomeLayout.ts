"use client";

import { useEffect, useState } from "react";
import useSWR, { mutate as globalMutate } from "swr";
import { fetcher, followOnlyOptions } from "@/lib/swr";
import { useServerHomeLayout } from "@/lib/usePlayerEnabled";

/**
 * La disposition de l'accueil (DECISIONS.md §52) : le choix du compte, et à défaut celui du
 * serveur. Réglée dans Compte → Interface, à côté du défilement guidé.
 *
 * Rangée dans les préférences du compte (`/api/user/preferences`), déjà chargées au démarrage par
 * `useAccountPreferencesLoader` : suivies sans être redemandées (`followOnlyOptions`, voir le piège
 * `revalidators[0]` de CLAUDE.md). Avant leur réponse, la dernière disposition vue sur cet
 * appareil — sans quoi un compte qui a choisi l'autre verrait l'accueil changer de forme une
 * seconde après le lancement —, puis celle du serveur.
 *
 * Une seule variante depuis le 13/10/2026 : le bouton « Tous les films / séries » est toujours
 * affiché, son option (`browseButton`) a disparu. Une colonne `home_browse_button` restée en base,
 * ou un ancien miroir qui la porte, ne sont plus lus.
 */
export type HomeLayout = { continueHero: boolean };
export type HomeLayoutChoice = { continueHero: boolean | null };

const KEY = "/api/user/preferences";
const MIRROR = "cine:home-layout";

type Prefs = { homeOwn?: HomeLayoutChoice; homeDefaults?: HomeLayout };

/** Le choix du compte s'il en a fait un, celui du serveur sinon — pour chaque variante. */
export function resolveHomeLayout(own: HomeLayoutChoice | undefined, defaults: HomeLayout): HomeLayout {
  return { continueHero: own?.continueHero ?? defaults.continueHero };
}

/** À la déconnexion : le miroir est rangé par appareil, et le compte suivant l'aurait lu. */
export function forgetHomeLayoutMirror(): void {
  try {
    window.localStorage.removeItem(MIRROR);
  } catch {
    // Stockage refusé : il n'y a rien à oublier.
  }
}

function lastKnown(): HomeLayout | null {
  try {
    const raw = window.localStorage.getItem(MIRROR);
    const v = raw ? (JSON.parse(raw) as Partial<HomeLayout>) : null;
    return v && typeof v.continueHero === "boolean" ? { continueHero: v.continueHero } : null;
  } catch {
    return null;
  }
}

export function useHomeLayout(): HomeLayout {
  const server = useServerHomeLayout();
  const { data } = useSWR<Prefs>(KEY, fetcher, followOnlyOptions);
  const known = data?.homeDefaults !== undefined;
  const layout = known ? resolveHomeLayout(data?.homeOwn, data.homeDefaults!) : null;
  const continueHero = layout?.continueHero;
  useEffect(() => {
    if (continueHero === undefined) return;
    try {
      window.localStorage.setItem(MIRROR, JSON.stringify({ continueHero }));
    } catch {
      /* navigation privée : la réponse du compte suffit */
    }
  }, [continueHero]);
  // Le miroir lu une fois, au montage : relu à chaque rendu, il coûtait un `localStorage` et un
  // `JSON.parse` à chaque survol et à chaque tour de la bannière, tant que la réponse du compte
  // n'était pas arrivée — et pour toujours si elle n'arrivait jamais (08/10/2026).
  const [mirror] = useState(() => (typeof window === "undefined" ? null : lastKnown()));
  if (layout) return layout;
  return mirror ?? server;
}

/** Pour l'écran du Compte : ce que le compte a choisi, et ce que le serveur donne par défaut. */
export function useHomeLayoutChoice(): { own: HomeLayoutChoice; defaults: HomeLayout } {
  const server = useServerHomeLayout();
  const { data } = useSWR<Prefs>(KEY, fetcher, followOnlyOptions);
  return { own: { continueHero: data?.homeOwn?.continueHero ?? null }, defaults: data?.homeDefaults ?? server };
}

/** Choisit une variante pour ce compte, ou rend la main au serveur (`null`). L'accueil suit tout de suite. */
export async function setHomeLayoutChoice(key: keyof HomeLayout, value: boolean | null): Promise<void> {
  const apply = (current?: Prefs): Prefs => ({
    ...(current ?? {}),
    homeOwn: { ...(current?.homeOwn ?? { continueHero: null }), [key]: value },
  });
  await globalMutate(
    KEY,
    async (current?: Prefs) => {
      const res = await fetch(KEY, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ home: { [key]: value } }) });
      if (!res.ok) throw new Error(String(res.status));
      return apply(current);
    },
    { optimisticData: apply, rollbackOnError: true, revalidate: false },
  );
}
