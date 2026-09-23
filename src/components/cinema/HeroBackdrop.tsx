"use client";

import { useEffect, useState } from "react";

/**
 * Le fond de l'accueil du bureau : un vrai fondu enchaîné d'un visuel au suivant.
 *
 * Chaque visuel était un `<img>` dont la clé suivait le titre : l'ancien était démonté d'un coup,
 * et le nouveau partait d'une opacité nulle sur le fond d'encre — un passage par le noir à chaque
 * changement. Et rien n'attendait son chargement : quand l'image n'était pas en cache, le fondu se
 * jouait à vide, puis l'image surgissait (relevé le 23/09/2026).
 *
 * Ici, deux couches au plus. Celle du dessous est le dernier visuel affiché ; celle du dessus, le
 * nouveau, reste invisible tant que son image n'est pas chargée, puis fond par-dessus. La couche
 * du dessous n'est retirée qu'une fois ce fondu fini. Un titre qui change avant que son image soit
 * là remplace simplement la couche en attente : on ne superpose jamais plus de deux visuels.
 *
 * Chaque couche porte ce que portait l'ancien fond : la copie floue et assombrie sur toute la
 * hauteur, puis la copie nette, masquée, par-dessus.
 */

/** `animate-fade-in` dure 180 ms (globals.css) ; un peu de marge avant de retirer le dessous. */
const HERO_FADE_MS = 240;

interface Layer {
  id: number | string;
  src: string | null;
  ready: boolean;
}

export function HeroBackdrop({ src, id, mask }: { src: string | null; id: number | string | null; mask: string }) {
  // Un titre sans visuel n'a rien à charger : sa couche est prête d'emblée, et fond sur l'encre.
  const [layers, setLayers] = useState<Layer[]>(() => (id === null ? [] : [{ id, src, ready: src === null }]));
  // Suivi pendant le rendu, et non dans un effet : la couche du nouveau titre existe dès le rendu
  // qui l'annonce (voir la documentation de React, « ajuster l'état quand une prop change »).
  const [seenId, setSeenId] = useState(id);
  if (id !== seenId) {
    setSeenId(id);
    if (id !== null) {
      setLayers((current) => {
        // Les couches déjà prêtes restent — deux au plus, celle affichée et celle qui est peut-être
        // encore en train de fondre par-dessus : retirer la première en plein fondu ferait
        // apparaître l'encre sous une image à demi transparente. Une couche en attente, elle, est
        // simplement remplacée. Et une couche ne peut pas porter deux fois le même titre (A, B,
        // puis A de nouveau) : on retire l'ancienne avant d'ajouter la nouvelle.
        const ready = current.filter((l) => l.ready);
        // Retour sur le visuel déjà affiché avant que le suivant ait chargé : rien à fondre.
        if (ready.at(-1)?.id === id) return ready.slice(-2);
        const shown = ready.filter((l) => l.id !== id).slice(-2);
        return [...shown, { id, src, ready: src === null }];
      });
    }
  }

  const markReady = (layerId: Layer["id"]) =>
    setLayers((current) => current.map((l) => (l.id === layerId ? { ...l, ready: true } : l)));

  // Une fois la couche du dessus prête, celles du dessous n'ont plus de rôle que le temps de son
  // fondu. Par un minuteur plutôt que par `animationend` : un onglet caché peut ne jamais émettre
  // l'événement, et c'est ainsi que toutes les sorties de l'application attendent leur animation.
  const top = layers.at(-1);
  const topReadyOver = top?.ready && layers.length > 1 ? top.id : null;
  useEffect(() => {
    if (topReadyOver === null) return;
    const timer = setTimeout(() => {
      setLayers((current) => {
        const at = current.findIndex((l) => l.id === topReadyOver);
        return at > 0 ? current.slice(at) : current;
      });
    }, HERO_FADE_MS);
    return () => clearTimeout(timer);
  }, [topReadyOver]);

  return (
    <>
      {layers.map((layer) => (
        <div
          key={layer.id}
          data-hero-layer={layer.ready ? "shown" : "loading"}
          className={`absolute inset-0 ${layer.ready ? "animate-fade-in" : "opacity-0"}`}
        >
          {layer.src && (
            <>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={layer.src} alt="" className="absolute inset-0 h-full w-full scale-110 object-cover object-top blur-2xl" />
              <div className="absolute inset-0 bg-ink/55" />
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={layer.src}
                alt=""
                className="absolute inset-0 h-full w-full object-cover object-top"
                style={{ maskImage: mask, WebkitMaskImage: mask }}
                // Le signal : l'image nette est décodable, la couche peut apparaître. En erreur
                // aussi — un visuel introuvable ne doit pas retenir le fond sur le titre d'avant.
                onLoad={() => markReady(layer.id)}
                onError={() => markReady(layer.id)}
              />
            </>
          )}
        </div>
      ))}
    </>
  );
}
