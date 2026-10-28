"use client";

import { useEffect, useState, type ComponentType, type ReactNode } from "react";

/**
 * Un morceau de code des livres chargé à la demande, **sans Suspense** (DECISIONS.md §127).
 *
 * `next/dynamic` passe par `React.lazy` et une frontière Suspense : React retient l'apparition de ce qui
 * était suspendu pendant 300 ms au moins (le « throttle » des frontières Suspense). Mesuré le 28/10/2026 :
 * entre un appui et le premier changement du document, ~320 ms pour « Tous les livres » et la catégorie
 * Livres, alors que leur code et leurs données arrivaient en 10 à 40 ms ; au clavier, sans le geste, la
 * même chose prenait 30 ms. Ici, le composant est rendu dès que son module est là — par un état, pas
 * par une suspension — et `preload()` permet de le demander avant d'en avoir besoin (l'intention, la
 * fiche) : rendu au même tour s'il est déjà chargé.
 */
export function lazyNow<P extends object>(load: () => Promise<ComponentType<P>>, fallback: ReactNode = null) {
  let loaded: ComponentType<P> | null = null;
  let pending: Promise<ComponentType<P>> | null = null;
  const preload = (): Promise<ComponentType<P>> =>
    (pending ??= load().then(
      (component) => (loaded = component),
      (error: unknown) => {
        pending = null;
        throw error;
      }
    ));

  function Lazy(props: P) {
    const [Component, setComponent] = useState<ComponentType<P> | null>(() => loaded);
    useEffect(() => {
      if (Component) return;
      let alive = true;
      preload()
        .then((c) => {
          if (alive) setComponent(() => c);
        })
        .catch(() => {
          /* hors ligne, ou un nouveau déploiement : le reste de la page vit sans ce morceau */
        });
      return () => {
        alive = false;
      };
    }, [Component]);
    return Component ? <Component {...props} /> : <>{fallback}</>;
  }
  return Object.assign(Lazy, { preload });
}
