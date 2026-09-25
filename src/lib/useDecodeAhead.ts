"use client";

import { useEffect, type RefObject } from "react";
import { noteWarmed } from "@/lib/imageReveal";

/**
 * Décoder les affiches avant qu'on les regarde.
 *
 * La grille complète saccadait **en descendant seulement**, et trois correctifs n'y avaient pas
 * suffi. Le banc a fini par nommer la cause (20/09/2026, `content-visibility`, le fondu et la
 * taille des affiches tour à tour neutralisés, processeur bridé six fois pour que les écarts se
 * voient) : ce qui coûte, c'est **une affiche qui arrive pendant le défilement**. Les mêmes six
 * secondes de molette parcourent 2 790 px quand les images arrivent en chemin, et 5 804 px quand
 * elles sont déjà là. Le reste — la structure des cartes, leurs transitions, `content-visibility` —
 * pèse le tiers de cet écart. En remontant, tout est déjà décodé : d'où l'asymétrie, et d'où le
 * fait qu'aucun réglage de mise en page ne l'ait jamais corrigée.
 *
 * Anticiper le *téléchargement* ne change rien, et c'est mesuré aussi : le coût n'est pas
 * d'attendre les octets, c'est de décoder l'image et de la peindre à l'image près où elle entre
 * dans le champ. `decode()` est la seule fonction qui déplace ce travail hors de ce moment-là.
 *
 * Trois mille pixels d'avance — deux écrans et demi. Mesuré contre 1 500, qui ne rattrape pas une
 * molette lancée, et contre le fait de tout décoder d'avance, qui reviendrait à charger six cent
 * soixante-dix affiches pour trois rangées regardées.
 *
 * Ce n'est pas l'image de chauffe qui s'affiche : c'est le cache de décodage du navigateur qu'on
 * remplit, et la carte y puisera quand son tour viendra. Elle est tenue un moment — voir `KEPT`.
 */
const AHEAD_PX = 3000;

/**
 * Combien d'affiches chauffées restent tenues, au plus — deux fois ce que couvrent les 3 000 px
 * de part et d'autre de l'écran sur un téléphone (trois colonnes, ≈ 45 cartes).
 *
 * Tenues, parce qu'une image jetée aussitôt laisse le navigateur libre d'oublier son décodage : sur
 * un iPhone, six cent quatre-vingts affiches décodées pèsent près d'un demi-gigaoctet, et il les
 * oublie. En remontant, elles étaient alors redécodées au moment d'entrer dans le champ — l'à-coup
 * dans les deux sens que Louis décrivait le 21/09/2026, sur « Tous les films » (702 titres) et
 * jamais sur les séries (137, qui tiennent en mémoire). Bornées, pour ne pas remplacer un
 * demi-gigaoctet oublié par un demi-gigaoctet retenu : les plus anciennes sont lâchées.
 */
const KEPT = 90;

/**
 * Le conteneur qui défile vraiment — celui qui doit servir de racine à l'observateur.
 *
 * La grille défile dans le corps de son panneau, pas dans la page. Un observateur sans racine
 * mesure contre la fenêtre, et le navigateur rogne d'abord chaque carte par ce conteneur : une
 * carte à 1 000 px sous le bord n'y a plus aucune surface, quelle que soit la marge. L'avance de
 * 3 000 px valait donc **zéro** depuis le 20/09 — mesuré le 21/09 dans Chromium et WebKit : douze
 * affiches chauffées au repos (l'écran), quarante-cinq avec cette racine. Le banc du 20/09 faisait
 * défiler la page elle-même, et ne pouvait pas le voir.
 */
function scrollingAncestor(element: HTMLElement): HTMLElement | null {
  for (let node = element.parentElement; node; node = node.parentElement) {
    const overflow = getComputedStyle(node).overflowY;
    if (overflow === "auto" || overflow === "scroll") return node;
  }
  return null;
}

/**
 * Chauffe **la variante que l'image affichée chargera**, pas une autre.
 *
 * Une affiche passée par l'optimiseur de Next porte un `srcset` (une adresse par largeur) et un
 * `sizes` ; son attribut `src` n'est que la plus grande variante, celle qu'aucun téléphone ne
 * charge. Chauffer `src` seul remplissait donc le cache d'une image que personne n'affiche. On
 * recopie les trois attributs : le navigateur fait alors, pour l'image de chauffe, exactement le
 * même choix que pour l'affiche — même écran, même densité, mêmes `sizes`. Une affiche sans
 * `srcset` (TMDB en direct, sur le téléphone) garde son `src`, qui est alors la bonne adresse.
 */
function warmLike(img: HTMLImageElement, kept: Map<string, HTMLImageElement>, limit: number): void {
  const src = img.getAttribute("src");
  if (!src) return;
  const srcset = img.getAttribute("srcset") ?? "";
  const key = `${srcset}|${src}`;
  // Déjà tenue : elle redevient la plus récente, et rien n'est redemandé.
  const held = kept.get(key);
  if (held) {
    kept.delete(key);
    kept.set(key, held);
    return;
  }
  const chauffe = new Image();
  const sizes = img.getAttribute("sizes");
  if (sizes) chauffe.sizes = sizes;
  if (srcset) chauffe.srcset = srcset;
  chauffe.src = src;
  // `decode` n'existe pas partout, et rejette pour une image absente — deux raisons de ne jamais
  // laisser cet appel remonter : c'est du confort, sur le chemin de personne. Une fois décodée, son
  // adresse est notée : l'affiche qui la chargera s'affichera sans fondu (`revealLoaded`).
  const decoded = chauffe.decode?.();
  if (decoded) decoded.then(() => noteWarmed(chauffe.currentSrc || chauffe.src)).catch(() => {});
  kept.set(key, chauffe);
  if (kept.size > limit) kept.delete(kept.keys().next().value!);
}

/** Le conteneur qui défile : lui-même s'il défile, sinon son premier ancêtre qui le fait. */
function scrollRoot(element: HTMLElement): HTMLElement | null {
  const overflow = getComputedStyle(element).overflowY;
  if (overflow === "auto" || overflow === "scroll") return element;
  return scrollingAncestor(element);
}

/** Les rangées d'affiches, sur le bureau (`data-tv-rowroot`) comme sur le téléphone (`data-poster-row`). */
const ROW_SELECTOR = "[data-tv-rowroot], [data-poster-row]";

/**
 * Les premières cartes d'une rangée qu'on chauffe quand la rangée approche : celles de l'écran,
 * et celles qu'un geste horizontal révèle d'abord. Pas toute la rangée — vingt-quatre affiches
 * par rangée, sur une quinzaine de rangées, dépasseraient de loin ce que `KEPT` autorise.
 */
export const ROW_CARDS = 12;

/**
 * Le même travail pour les rangées de l'accueil (25/09/2026).
 *
 * « Tous les films » décodait ses affiches trois mille pixels à l'avance, les rangées de l'accueil
 * jamais : elles chargeaient chaque affiche en approchant de l'écran, la décodaient au dernier
 * moment et l'annonçaient en fondu — en descendant, les affiches « se génèrent au fur et à
 * mesure », quand la grille paraissait tout rendre d'un coup.
 *
 * Deux axes à la fois. Verticalement, les rangées situées jusqu'à deux écrans et demi sous le bord ;
 * horizontalement, les `ROW_CARDS` premières cartes de chacune, parce qu'une carte hors du champ
 * de sa propre rangée n'intersecte jamais rien — la rangée la rogne. Les rangées qui apparaissent
 * plus tard (le catalogue arrive, l'onglet Séries s'ouvre) sont prises au vol ; une rangée cachée
 * (l'onglet qu'on ne regarde pas) n'a pas de surface et n'est jamais chauffée. La même borne que
 * la grille : au-delà de `KEPT` affiches tenues, les plus anciennes sont lâchées.
 */
export function useDecodeRowsAhead(container: RefObject<HTMLElement | null>, enabled = true): void {
  useEffect(() => {
    // `enabled` : sur le bureau, le panneau des rangées n'existe pas tant que l'écran de
    // chargement le remplace ; l'effet doit repartir quand il apparaît.
    const host = container.current;
    if (!enabled || !host || typeof IntersectionObserver === "undefined") return;
    const kept = new Map<string, HTMLImageElement>();
    const near = new Set<Element>();
    const warmRow = (row: Element) => {
      const images = row.querySelectorAll("img");
      for (let i = 0; i < images.length && i < ROW_CARDS; i++) warmLike(images[i], kept, KEPT);
    };
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            near.add(entry.target);
            warmRow(entry.target);
          } else near.delete(entry.target);
        }
      },
      { root: scrollRoot(host), rootMargin: `${Math.round(window.innerHeight * 2.5)}px 0px` }
    );
    const followed = new WeakSet<Element>();
    const follow = () => {
      for (const row of host.querySelectorAll(ROW_SELECTOR)) {
        if (followed.has(row)) continue;
        followed.add(row);
        observer.observe(row);
      }
      // Une rangée déjà proche dont les affiches viennent seulement d'arriver (son squelette
      // remplacé par le catalogue) : on la rechauffe — ce qui est déjà tenu ne coûte rien.
      for (const row of near) if (row.isConnected) warmRow(row);
    };
    follow();
    // Regroupé : l'écran change sans cesse (la bannière, le focus d'une carte), et chacun de ces
    // changements n'a pas à relancer une recherche des rangées. Une fois tous les 200 ms au plus.
    let scheduled: ReturnType<typeof setTimeout> | null = null;
    const schedule = () => {
      if (scheduled) return;
      scheduled = setTimeout(() => {
        scheduled = null;
        follow();
      }, 200);
    };
    const mutations = typeof MutationObserver === "undefined" ? null : new MutationObserver(schedule);
    mutations?.observe(host, { childList: true, subtree: true });
    return () => {
      if (scheduled) clearTimeout(scheduled);
      observer.disconnect();
      mutations?.disconnect();
      kept.clear();
      near.clear();
    };
  }, [container, enabled]);
}

export function useDecodeAhead(grid: RefObject<HTMLElement | null>, items: unknown): void {
  useEffect(() => {
    const root = grid.current;
    if (!root || typeof IntersectionObserver === "undefined") return;

    // Adresse → image de chauffe, dans l'ordre d'usage : la plus ancienne est la première lâchée.
    const kept = new Map<string, HTMLImageElement>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const img = entry.target.querySelector("img");
          if (img) warmLike(img, kept, KEPT);
        }
      },
      // Chaque carte reste suivie : elle se rechauffe à chaque fois qu'elle rentre dans la marge,
      // en descendant comme en remontant.
      { root: scrollingAncestor(root), rootMargin: `${AHEAD_PX}px 0px` }
    );

    for (const card of root.children) observer.observe(card);
    return () => {
      observer.disconnect();
      kept.clear();
    };
    /**
     * **La liste elle-même, et non son nombre d'éléments.**
     *
     * Première version : `items.length`. Elle a l'air prudente et elle est fausse — changer le
     * tri garde exactement le même nombre de cartes, donc l'effet ne repartait pas. Or
     * l'observateur ne suivait que les cartes présentes à son montage : après un changement de
     * tri, le premier écran n'était plus anticipé du tout, précisément là où quelqu'un se remet à
     * faire défiler.
     *
     * La liste est mémoïsée par l'appelant sur ses filtres, donc son identité ne change que
     * lorsque son contenu change : c'est exactement la dépendance qu'il fallait.
     */
  }, [grid, items]);
}
