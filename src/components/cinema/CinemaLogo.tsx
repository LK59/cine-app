"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { useImageRetry } from "@/lib/useImageRetry";

/**
 * Le logo d'un titre, à une taille qui ne dépend pas de la forme du logo.
 *
 * Chacun des cinq endroits qui en affichait un plafonnait sa hauteur et sa largeur, ce qui
 * paraît raisonnable et ne l'est pas : ces images n'ont aucune proportion commune. « SUNSHINE »
 * tient sur une ligne — plafonné en hauteur, il reste bas et s'étale, donc c'est la largeur qui
 * l'arrête. « CASINO ROYALE » est empilé sur deux lignes — il atteint le plafond de hauteur tout
 * de suite et se retrouve deux fois plus petit à l'œil, alors que la règle appliquée est la
 * même. D'où la sensation, juste, que les tailles ne sont pas constantes.
 *
 * La hauteur est donc corrigée par la proportion de l'image, mesurée au chargement : plus un
 * logo est long, moins il a besoin de hauteur pour peser autant. Ce que l'on égalise n'est pas
 * une dimension, c'est l'encombrement apparent.
 */

/**
 * Les proportions rencontrées, et ce qu'elles valent en hauteur relative.
 *
 * L'écart entre les extrêmes reste ce qui égalise l'encombrement apparent ; c'est le niveau
 * général qui était trop bas — corriger la hauteur d'un logo long revenait à rapetisser tout le
 * monde, puisque le plafond de base était celui d'un logo carré.
 */
function heightFactor(ratio: number | null): number {
  if (ratio === null) return 1;
  if (ratio >= 5.5) return 0.78; // une ligne très longue : « MISSION: IMPOSSIBLE »
  if (ratio >= 3.5) return 0.9; // une ligne ordinaire : « SUNSHINE »
  if (ratio >= 2) return 1.05; // un mot large ou deux lignes courtes
  // Empilé ou presque carré : « CASINO ROYALE », « Le Parrain ». Ces images-là portent souvent
  // une marge transparente autour du dessin, donc la hauteur mesurée est plus grande que la
  // marque visible : sans ce supplément, elles paraissent petites à hauteur égale.
  return 1.4;
}

/** Les trois surfaces qui portent un logo, et la hauteur qu'elles lui accordent. */
const SURFACES = {
  /**
   * La bannière du haut, sur l'écran de parcours — bornée aussi par la hauteur de son volet
   * (`fit`, voir `SurfaceFit`).
   */
  hero: { compact: 76, roomy: 132, maxWidth: "min(100%, 42rem)", fit: { reserve: "18.5rem", floor: 48 } },
  /** La fiche plein écran. */
  sheet: { compact: 68, roomy: 120, maxWidth: "min(100%, 32rem)" },
  /** Le téléphone, où la place est comptée dans les deux sens. */
  phone: { compact: 52, roomy: 76, maxWidth: "min(100%, 21rem)" },
  /**
   * Le titre du lecteur, en bas à gauche (09/10/2026) : la hauteur du titre écrit qu'il remplace,
   * pas plus — un logo haut ou carré n'a pas à manger l'image du film.
   */
  player: { compact: 28, roomy: 40, maxWidth: "min(100%, 22rem)" },
} as const;

/**
 * Une surface dont la hauteur est comptée : le logo y prend ce que le reste lui laisse.
 *
 * La bannière du bureau est une colonne calée en bas d'un volet de 44 % de la hauteur, et tout ce
 * qui est sous le logo — métadonnées, deux lignes de synopsis, « Lire », les traits du carrousel,
 * la marge du bas — a une hauteur fixe. Le palier `ROOMY_FROM` ne regardait que la fenêtre : à
 * 768 px de haut (un 13 pouces, 12/10/2026), 132 px de logo s'ajoutaient à ces ~200 px dans un
 * volet de 338, et la colonne débordait par le haut, hors de l'écran — la première ligne de
 * « Weathering With You » coupée, le reste de la bannière écrasé dessous. Le palier ne pouvait
 * pas être juste : la place laissée au logo dépend de la hauteur du volet, pas d'un seuil.
 *
 * Le logo est donc plafonné, en plus, à la hauteur du volet (`100cqh` : le volet est un
 * conteneur de taille, voir CinemaClient) moins `reserve` — le bloc du dessous plus de quoi
 * passer sous la bascule Films / Séries. En rem, comme ce bloc : sous la taille de base réduite
 * des petits portables (globals.css), les deux rétrécissent ensemble. `floor` : en dessous, un
 * logo n'est plus lisible ; l'écran est alors si court que la colonne cède plutôt que le titre
 * (`justify-end-safe` sur la colonne). Sur un grand écran, le plafond habituel l'emporte et rien
 * ne change. Sans conteneur autour, `cqh` vaut la hauteur de la fenêtre : le plafond s'efface.
 */
type SurfaceFit = { reserve: string; floor: number };

/** En dessous, la fenêtre est trop courte pour la hauteur généreuse. */
const ROOMY_FROM = 760;

/**
 * Les proportions déjà mesurées, gardées d'une carte à l'autre.
 *
 * La hauteur d'un logo dépend de sa forme, et sa forme ne se connaît qu'une fois l'image
 * chargée : la première fois, il s'affichait donc à la hauteur par défaut puis se corrigeait
 * sous les yeux. Une image déjà vue — c'est le cas dès qu'on repasse sur un titre — n'a plus à
 * repasser par là.
 */
const KNOWN_RATIOS = new Map<string, number>();

export function CinemaLogo({
  src,
  alt,
  surface,
  className = "",
  onError,
  fallback = null,
  shadow = true,
}: {
  src: string;
  alt: string;
  surface: keyof typeof SURFACES;
  className?: string;
  onError?: () => void;
  /**
   * Ce qui nomme le titre quand le logo ne vient pas — en pratique, le titre écrit.
   *
   * Tenu ici plutôt que par chaque appelant : cinq endroits le faisaient chacun à sa façon, et le
   * sixième, la bannière du téléphone, l'avait oublié. Une image refusée y laissait l'icône
   * d'image cassée de Safari au milieu de l'affiche, et plus aucun nom (*Dallas Buyers Club*,
   * 21/09/2026) — d'autant plus visible que la proportion déjà connue rendait l'image opaque.
   */
  fallback?: ReactNode;
  /**
   * Le contour sombre (deux ombres plates). Faux sur la fiche du téléphone (09/10/2026) : un filtre
   * fait dessiner l'image sur un calque à part, et Safari, quand ce calque était sorti de l'écran
   * d'une fiche ensuite recouverte (acteur, film, saga), ne le redessinait plus au retour — le logo
   * restait invisible jusqu'au premier mouvement de la fiche. Là, le logo est posé sous l'image, sur
   * la partie sombre : le contour n'y servait presque à rien.
   */
  shadow?: boolean;
}) {
  const [ratio, setRatio] = useState<number | null>(() => KNOWN_RATIOS.get(src) ?? null);
  // L'adresse refusée, et non un simple drapeau : un autre logo passé à la même instance a droit
  // à sa chance.
  // Un échec n'est plus définitif (`useImageRetry`, DECISIONS.md) : le repli (le titre écrit) tient
  // la place, l'adresse est retentée hors du document, et le logo revient en fondu une fois en cache.
  const retry = useImageRetry(src, { mode: "probe" });
  const [roomy, setRoomy] = useState(true);
  const imgRef = useRef<HTMLImageElement>(null);

  useEffect(() => {
    const measure = () => setRoomy(window.innerHeight >= ROOMY_FROM);
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);

  // Une image déjà en cache est parfois complète avant même que React n'ait posé son `onLoad` :
  // sans ce rattrapage, elle resterait invisible, attendant un événement qui a déjà eu lieu.
  useEffect(() => {
    const img = imgRef.current;
    if (!img?.complete || !img.naturalHeight) return;
    remember(src, img.naturalWidth / img.naturalHeight, setRatio);
  }, [src]);

  if (retry.failed) return <>{fallback}</>;

  const spec = SURFACES[surface];
  const { compact, roomy: tall, maxWidth } = spec;
  const capped = (roomy ? tall : compact) * heightFactor(ratio);
  // Le plafond de la surface reste celui qui égalise l'encombrement ; la place réelle ne s'y
  // ajoute qu'en limite absolue, sans facteur de forme — un logo empilé (×1,4) n'a pas plus de
  // place qu'un autre dans le même volet.
  const fit: SurfaceFit | undefined = "fit" in spec ? spec.fit : undefined;
  const maxHeight = fit ? `min(${capped}px, max(${fit.floor}px, calc(100cqh - ${fit.reserve})))` : capped;

  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt={alt}
      // Un logo n'est pas une image à emporter : glissé, il partait en fantôme au lieu de laisser le
      // geste au lecteur ou à la fiche (11/10/2026).
      draggable={false}
      onError={() => {
        retry.onError();
        onError?.();
      }}
      ref={imgRef}
      onLoad={(e) => {
        retry.onLoad();
        const img = e.currentTarget;
        if (img.naturalHeight > 0) remember(src, img.naturalWidth / img.naturalHeight, setRatio);
      }}
      style={{
        maxHeight,
        maxWidth,
        /**
         * Deux ombres portées plates plutôt qu'une ombre floue.
         *
         * `drop-shadow` avec un rayon de vingt pixels oblige le navigateur à retramer l'image à
         * chaque fois que la surface qui la porte bouge — et sur le téléphone, cette surface est
         * une piste que le doigt déplace en continu. Un rayon nul se rasterise une fois et se
         * déplace avec la texture ; deux passes décalées suffisent à détacher un logo blanc d'un
         * fond clair, ce à quoi cette ombre sert.
         */
        filter: shadow ? "drop-shadow(0 2px 0 rgb(0 0 0 / 0.55)) drop-shadow(0 -1px 0 rgb(0 0 0 / 0.35))" : undefined,
        // Rien n'est montré avant que la forme soit connue : le logo apparaissait à la hauteur
        // par défaut puis se corrigeait sous les yeux, ce qui se voyait comme un sursaut. Il
        // paraît maintenant déjà à sa taille — la mesure prend une image, l'apparition en prend
        // trois, et l'une couvre l'autre.
        //
        // Sans fondu (09/10/2026) : la transition d'opacité restait parfois figée à son départ sous
        // WebKit — reproduit, `CSSTransition` « running » à 0 ms plusieurs secondes après —, et le
        // logo demeurait invisible, sa place tenue, jusqu'à ce qu'on rouvre la fiche (Casino
        // Royale après une fiche de la saga, sur iPhone). Un logo déjà vu est de toute façon montré
        // d'emblée (`KNOWN_RATIOS`) ; un nouveau apparaît d'un coup, à sa taille.
        opacity: ratio === null ? 0 : 1,
      }}
      /**
       * `self-start` : sans lui, l'image s'étirait à la largeur de sa colonne.
       *
       * Ces logos vivent dans un `flex flex-col`, dont l'alignement par défaut est `stretch` :
       * une image y prend toute la largeur disponible, et `object-contain` centre alors le
       * dessin à l'intérieur de cette boîte. D'où « le Parrain » décalé de trois cents pixels
       * vers la droite, alors que le texte sous lui commençait au bord — et d'où l'impression
       * qu'il était petit, puisque seule sa hauteur le limitait dans une boîte trop large.
       * Un appelant qui veut le centrer passe `mx-auto`, dont les marges automatiques
       * l'emportent sur cet alignement.
       */
      className={`w-auto self-start object-contain ${retry.recovered ? "animate-fade-in" : ""} ${className}`}
    />
  );
}

/** Retient la proportion mesurée, pour cette image et pour les prochaines fois. */
function remember(src: string, ratio: number, apply: (value: number) => void): void {
  KNOWN_RATIOS.set(src, ratio);
  apply(ratio);
}
