"use client";

import { useEffect, type RefObject } from "react";
import { prefersReducedMotion } from "@/lib/reducedMotion";

/**
 * Les cartes qui montent rejoindre leur rangée.
 *
 * Depuis que les affiches sont prêtes d'avance (décodées avant d'être vues), elles arrivaient
 * brutes pendant le défilement ; un fondu, même de 180 ms, donnait au contraire l'impression d'une
 * attente — une image qui se révèle, c'est une image qui charge (Louis, 25/09/2026). Ce qu'il
 * voulait : l'image déjà là, et la carte entière qui **monte** à sa place avec un léger rebond en
 * entrant dans l'écran. Les cartes qui entrent ensemble partent en petite vague, de gauche à droite.
 *
 * Rien pour ce qui est déjà à l'écran quand on l'observe pour la première fois — l'ouverture,
 * le retour sur un onglet gardé, un écran remonté — : on ne rejoue pas une arrivée, ça passerait
 * pour un rechargement. Rien non plus pendant la courte fenêtre qui suit un changement d'onglet
 * (`suppressRise`), où tout un volet caché devient visible d'un coup. Et rien du tout quand
 * l'appareil demande moins de mouvement.
 *
 * Une carte ne monte qu'une fois : l'animation dit « elle arrive », pas « elle repasse ».
 */

/** Ce qui est une carte : celles du bureau (`data-tv-card`), celles des rangées du téléphone, et
 *  les autres, marquées explicitement. */
export const RISE_SELECTOR = "[data-tv-card], [data-poster-row] .pressable, [data-rise-card]";

const RISE_MS = 420;
/** Entre deux cartes d'une même vague. */
const STAGGER_MS = 35;
/** Au plus : une vague ne doit jamais retarder la dernière carte au point qu'on l'attende. */
const MAX_STAGGER_MS = 210;
const KEYFRAMES: Keyframe[] = [
  { transform: "translateY(22px) scale(0.95)" },
  { transform: "translateY(-3px) scale(1.01)", offset: 0.62 },
  { transform: "none" },
];
const EASING = "cubic-bezier(0.22, 1, 0.36, 1)";

let suppressedUntil = 0;
const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

/** Un volet entier devient visible (changement d'onglet) : ses cartes s'affichent sans monter. */
export function suppressRise(ms = 400): void {
  suppressedUntil = now() + ms;
}

/**
 * Suit les cartes sous `rootRef`, y compris celles qui apparaissent plus tard (rangées ajoutées,
 * grille qui grandit), et fait monter celles qui entrent dans l'écran après leur première
 * observation.
 */
export function useRiseIn(rootRef: RefObject<HTMLElement | null>, selector: string = RISE_SELECTOR): void {
  useEffect(() => {
    const root = rootRef.current;
    if (!root || typeof IntersectionObserver === "undefined" || prefersReducedMotion()) return;

    const seen = new WeakSet<Element>();
    const risen = new WeakSet<Element>();
    const observer = new IntersectionObserver(
      (entries) => {
        const arriving: HTMLElement[] = [];
        for (const entry of entries) {
          const el = entry.target as HTMLElement;
          const first = !seen.has(el);
          seen.add(el);
          if (!entry.isIntersecting) continue;
          observer.unobserve(el);
          if (risen.has(el)) continue;
          risen.add(el);
          // Déjà là à la première observation, ou révélé d'un coup par un changement d'onglet.
          if (first || now() < suppressedUntil) continue;
          arriving.push(el);
        }
        if (arriving.length === 0) return;
        // La vague part de la gauche, puis du haut.
        arriving.sort((a, b) => {
          const ra = a.getBoundingClientRect();
          const rb = b.getBoundingClientRect();
          return Math.abs(ra.top - rb.top) > 8 ? ra.top - rb.top : ra.left - rb.left;
        });
        arriving.forEach((el, i) => {
          if (typeof el.animate !== "function") return;
          el.animate(KEYFRAMES, { duration: RISE_MS, easing: EASING, delay: Math.min(i * STAGGER_MS, MAX_STAGGER_MS), fill: "backwards" });
        });
      },
      { threshold: 0.12 }
    );

    const watch = (scope: ParentNode) => {
      for (const el of scope.querySelectorAll(selector)) {
        if (!seen.has(el) && !risen.has(el)) observer.observe(el);
      }
    };
    watch(root);
    // Les rangées et les cartes qui arrivent après coup — un passage par image au plus.
    let pending = false;
    const mutations = new MutationObserver(() => {
      if (pending) return;
      pending = true;
      requestAnimationFrame(() => {
        pending = false;
        watch(root);
      });
    });
    mutations.observe(root, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
      mutations.disconnect();
    };
  }, [rootRef, selector]);
}
