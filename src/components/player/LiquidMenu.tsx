"use client";

import { useLayoutEffect, useRef, type CSSProperties, type ReactNode, type RefObject } from "react";
import { LIQUID_SPRING, prefersReducedMotion, toSpring } from "@/lib/liquidGlass/liquid";
import { springKeyframes } from "@/lib/liquidGlass/spring";

/**
 * Un menu du lecteur, né de la pilule des réglages (DECISIONS.md §45).
 *
 * Une seule surface qui change de forme : découpée au départ exactement à la pilule (même verre,
 * même place — la pilule s'efface dessous), elle s'ouvre vers le haut et la gauche sur le ressort.
 * L'icône du bouton touché glisse jusqu'à l'en-tête et devient le titre ; la liste apparaît en
 * fondu — porté par le contenu, jamais par la surface floutée.
 *
 * **La fermeture ne retarde rien.** Le menu se démonte à l'instant où il se ferme, comme avant :
 * le focus, le clavier, ce que les tests lisent, rien ne change. Ce qui se referme à l'écran est
 * une copie inerte, posée à sa place au démontage et retirée une fois le geste fini — rapide
 * (200 ms), depuis l'état où il était : un toucher à côté *pendant* l'ouverture le referme d'où il
 * en est, sans attendre la fin du ressort (demandé le 04/10/2026). La pilule revient quand le
 * menu a retrouvé sa forme, en fondu croisé.
 *
 * Changer de vue (⋮ → minuterie) garde la surface : si elle grandit, elle se déroule vers le haut.
 */

const CLOSE_MS = 200;
/**
 * L'ouverture rebondit : un ressort moins amorti que celui des gestes, dont le dépassement se lit
 * en échelle — le petit « pop » des menus d'iOS. Avec le ressort des gestes (amortissement 0,8),
 * le dépassement restait sous le demi-pour-cent : rien ne se voyait (04/10/2026). Le premier
 * réglage (0,42 s / 0,62 : ≈ 8 % de dépassement, posé en 0,75 s) paraissait lent et rebondissait
 * deux fois (07/10/2026) : plus vif et un peu plus amorti, le pop reste (≈ 2 % d'échelle) et se
 * pose en un seul aller-retour.
 */
export const OPEN_SPRING = toSpring(0.34, 0.72);
const OPEN_BOUNCE = 0.5;
/**
 * L'icône ne rebondit pas. Elle voyageait sur le ressort de la boîte, et son dépassement, pris
 * sur tout le trajet du bouton à l'en-tête (deux cents pixels et plus), la portait au-delà du
 * coin du menu, presque hors de lui (07/10/2026). Seul le contenant rebondit ; ce qui voyage à
 * l'intérieur arrive, amorti au critique, en même temps que lui.
 */
export const ICON_SPRING = toSpring(0.3, 1);
/**
 * Pendant qu'elle s'ouvre, la boîte s'allonge dans le sens où elle part — vers le haut — et se
 * resserre un peu en largeur, puis reprend sa forme en se posant : la matière des menus d'iOS
 * récents, plutôt qu'une forme rigide qu'on agrandit (07/10/2026). Lu sur la vitesse du ressort,
 * borné à 4 % ; au retour du dépassement, la vitesse s'inverse et la boîte se tasse à peine.
 */
const OPEN_STRETCH = 0.008;
const OPEN_STRETCH_MAX = 0.04;
const OPEN_SQUASH_MAX = 0.015;
/**
 * Les lignes arrivent l'une après l'autre, de haut en bas, 18 ms d'écart : la liste se déplie au
 * lieu de s'allumer d'un bloc. Au-delà de huit lignes, les suivantes partent avec la huitième —
 * une longue liste de pistes ne doit pas rallonger l'ouverture.
 */
const ROW_STAGGER_MS = 18;
const ROW_STAGGER_MAX = 8;

/** L'étirement d'une vitesse d'ouverture `v` (fractions d'ouverture par seconde). */
export function openStretch(v: number) {
  return Math.min(OPEN_STRETCH_MAX, Math.max(-OPEN_SQUASH_MAX, v * OPEN_STRETCH));
}
/** L'étirement d'une liste tirée au-delà de son bout : au plus 6 % de la hauteur du menu. */
const OVERSCROLL_STRETCH = 0.35;
const OVERSCROLL_MAX = 0.06;
const HANDOVER_MS = 110;
const RADIUS = 22;

/** La place d'un élément dans un ancêtre, en coordonnées de mise en page : les `transform` d'un geste en cours n'y entrent pas. */
function layoutBox(el: HTMLElement, ancestor: Element | null) {
  let x = 0;
  let y = 0;
  let node: HTMLElement | null = el;
  while (node && node !== ancestor) {
    x += node.offsetLeft;
    y += node.offsetTop;
    node = node.offsetParent as HTMLElement | null;
  }
  return { x, y, w: el.offsetWidth, h: el.offsetHeight };
}

const canAnimate = () => typeof HTMLElement !== "undefined" && typeof HTMLElement.prototype.animate === "function";

/** La découpe d'une ouverture `p` (0 : la pilule, 1 : le menu entier). */
function clipAt(p: number, top: number, left: number, pillRadius: number) {
  const q = Math.min(Math.max(p, 0), 1);
  return `inset(${top * (1 - q)}px 0px 0px ${left * (1 - q)}px round ${pillRadius * (1 - q) + RADIUS * q}px)`;
}

export function LiquidMenu({
  menuRef,
  anchorRef,
  originRef,
  view,
  title,
  icon,
  className,
  style,
  onClick,
  onClickCapture,
  children,
}: {
  menuRef: RefObject<HTMLDivElement | null>;
  /** La pilule d'où le menu naît. */
  anchorRef: RefObject<HTMLElement | null>;
  /** Le bouton touché, dont l'icône glisse jusqu'à l'en-tête. */
  originRef: RefObject<HTMLElement | null>;
  /** La vue affichée : en changer garde la surface. */
  view: string;
  title: string;
  icon: ReactNode;
  className: string;
  style: CSSProperties;
  onClick: (e: React.MouseEvent) => void;
  onClickCapture: () => void;
  children: ReactNode;
}) {
  const iconRef = useRef<HTMLSpanElement>(null);
  const titleRef = useRef<HTMLSpanElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const geometry = useRef({ top: 0, left: 0, pillRadius: 0, height: 0 });
  const firstView = useRef(view);

  // L'ouverture, et — au démontage — la copie qui se referme.
  useLayoutEffect(() => {
    const box = menuRef.current;
    const anchor = anchorRef.current;
    const listEl = listRef.current;
    const parent = box?.offsetParent ?? null;
    if (!box) return;
    const animated = canAnimate() && !prefersReducedMotion() && !!anchor && anchor.offsetWidth > 0;

    // Ancré sur la pilule : son coin bas-droit est celui du menu.
    if (anchor && anchor.offsetWidth > 0 && parent) {
      const p = layoutBox(anchor, parent);
      box.style.right = `${parent.clientWidth - (p.x + p.w)}px`;
      box.style.bottom = `${parent.clientHeight - (p.y + p.h)}px`;
      box.style.maxHeight = `${Math.max(120, Math.min(280, p.y + p.h - 16))}px`;
    }
    if (!animated || !anchor) return;

    // L'animation n'est qu'un habillage : quoi qu'il arrive en elle, le menu reste un menu. Une
    // exception levée ici, dans un effet, emporterait le lecteur entier avec elle.
    try {
      openMorph(box, anchor, parent);
    } catch {
      box.removeAttribute("data-morph");
      for (const a of anchor.getAnimations?.() ?? []) if (a.id === "menu-cover") a.cancel();
      anchor.dataset.menuCover = "0";
      return;
    }

    return () => {
      try {
        closeGhost(box, anchor);
      } catch {
        for (const a of anchor.getAnimations?.() ?? []) if (a.id === "menu-cover") a.cancel();
      }
    };

    function openMorph(box: HTMLDivElement, anchor: HTMLElement, parent: Element | null) {
    box.setAttribute("data-morph", "");
    const W = box.offsetWidth;
    const H = box.offsetHeight;
    const g = geometry.current;
    g.top = Math.max(0, H - anchor.offsetHeight);
    g.left = Math.max(0, W - anchor.offsetWidth);
    g.pillRadius = anchor.offsetHeight / 2;
    g.height = H;

    const shape = springKeyframes(0, 1, OPEN_SPRING, ({ x, v }) => {
      // Le dépassement ne peut pas agrandir la découpe au-delà de la boîte : il passe en échelle,
      // depuis le coin d'où le menu naît. Au repos, l'origine revient au centre : c'est d'elle que
      // le geste liquide gonfle et étire la surface.
      const pop = 1 + Math.max(0, x - 1) * OPEN_BOUNCE;
      const k = openStretch(v);
      return {
        clipPath: clipAt(x, g.top, g.left, g.pillRadius),
        transform: `scale(${pop * (1 - k / 2)}, ${pop * (1 + k)})`,
        transformOrigin: "100% 100%",
      };
    });
    box.animate(shape.keyframes, { duration: shape.duration, easing: "linear" });

    // L'icône part de celle du bouton touché.
    const origin = originRef.current;
    const icon = iconRef.current;
    if (origin && icon && origin.offsetWidth > 0) {
      const o = layoutBox(origin, parent);
      const i = layoutBox(icon, parent);
      const dx = o.x + o.w / 2 - (i.x + i.w / 2);
      const dy = o.y + o.h / 2 - (i.y + i.h / 2);
      const path = springKeyframes(0, 1, ICON_SPRING, ({ x }) => ({ transform: `translate(${dx * (1 - x)}px, ${dy * (1 - x)}px)` }));
      icon.animate(path.keyframes, { duration: path.duration, easing: "linear" });
    }
    titleRef.current?.animate([{ opacity: 0, transform: "translateX(-6px)" }, { opacity: 1, transform: "none" }], { duration: 160, delay: 40, easing: "ease-out", fill: "backwards" });
    // Ligne par ligne : chacune monte de 4 px en apparaissant, la suivante 18 ms plus tard.
    const rows = listRef.current ? Array.from(listRef.current.children) : [];
    rows.forEach((row, i) =>
      row.animate([{ opacity: 0, transform: "translateY(4px)" }, { opacity: 1, transform: "none" }], {
        duration: 180,
        delay: 50 + Math.min(i, ROW_STAGGER_MAX) * ROW_STAGGER_MS,
        easing: "ease-out",
        fill: "backwards",
      }),
    );

    // La pilule s'efface sous le menu qui naît d'elle.
    anchor.dataset.menuCover = "1";
    for (const a of anchor.getAnimations()) if (a.id === "menu-cover") a.cancel();
    const hide = anchor.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 90, fill: "forwards" });
    hide.id = "menu-cover";
    }

    function closeGhost(box: HTMLDivElement, anchor: HTMLElement) {
      const g = geometry.current;
      // Démonté : le vrai menu part maintenant ; sa copie se referme à sa place.
      anchor.dataset.menuCover = "0";
      const host = box.parentElement;
      const restorePill = () => {
        if (anchor.dataset.menuCover === "1") return; // un autre menu s'est ouvert entre-temps
        for (const a of anchor.getAnimations()) if (a.id === "menu-cover") a.cancel();
        anchor.animate([{ opacity: 0 }, { opacity: 1 }], { duration: HANDOVER_MS, easing: "ease-out" });
      };
      if (!host || !box.isConnected) {
        restorePill();
        return;
      }
      // D'où il en est : la découpe en cours dit l'ouverture atteinte.
      const clip = getComputedStyle(box).clipPath;
      const m = /inset\(\s*([\d.]+)px/.exec(clip ?? "");
      const p0 = m && g.top > 0 ? 1 - Number(m[1]) / g.top : 1;
      const ghost = box.cloneNode(true) as HTMLDivElement;
      ghost.classList.remove("player-menu");
      ghost.classList.add("player-menu-ghost");
      ghost.removeAttribute("id");
      ghost.setAttribute("aria-hidden", "true");
      ghost.inert = true;
      ghost.style.pointerEvents = "none";
      for (const el of ghost.querySelectorAll("[id], [data-player-nav]")) {
        el.removeAttribute("id");
        el.removeAttribute("data-player-nav");
      }
      host.insertBefore(ghost, box.nextSibling);
      const list = ghost.querySelector<HTMLElement>(".player-menu-list");
      if (list && listEl) list.scrollTop = listEl.scrollTop;
      const geo = { ...g };
      ghost.animate(
        [
          { clipPath: clipAt(p0, geo.top, geo.left, geo.pillRadius), transform: "scale(1)" },
          { clipPath: clipAt(0, geo.top, geo.left, geo.pillRadius), transform: "scale(1)" },
        ],
        { duration: CLOSE_MS, easing: "cubic-bezier(0.3, 0, 0.2, 1)", fill: "forwards" },
      );
      for (const part of [ghost.querySelector(".player-menu-list"), ghost.querySelector(".player-menu-title")]) {
        (part as HTMLElement | null)?.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 90, fill: "forwards" });
      }
      window.setTimeout(() => {
        restorePill();
        ghost.animate([{ opacity: 1 }, { opacity: 0 }], { duration: HANDOVER_MS, easing: "ease-out", fill: "forwards" });
      }, CLOSE_MS - 60);
      window.setTimeout(() => ghost.remove(), CLOSE_MS - 60 + HANDOVER_MS + 20);
    }
    // Une seule ouverture par montage : la vue qui change ensuite garde la surface (voir plus bas).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * Une liste tirée au-delà de son début ou de sa fin étire la boîte entière, vers le doigt, et la
   * boîte revient avec le rebond de la liste (04/10/2026). Lu sur la position de défilement elle-
   * même : pendant ce rebond, le système la porte au-delà des bornes (iOS, et Safari au pavé
   * tactile), et c'est lui qui la ramène — la boîte suit, sans geste à elle ni minuterie. Écrit
   * dans `scale` et non `transform` : le geste liquide et l'ouverture tiennent déjà celui-là.
   */
  useLayoutEffect(() => {
    const box = menuRef.current;
    const list = listRef.current;
    if (!box || !list || prefersReducedMotion()) return;
    let frame = 0;
    const apply = () => {
      frame = 0;
      const max = list.scrollHeight - list.clientHeight;
      const over = list.scrollTop < 0 ? -list.scrollTop : list.scrollTop > max ? list.scrollTop - max : 0;
      if (over <= 0) {
        box.style.scale = "";
        box.style.transformOrigin = "";
        return;
      }
      const k = Math.min(OVERSCROLL_MAX, (over / Math.max(box.offsetHeight, 1)) * OVERSCROLL_STRETCH);
      // Tirée vers le bas en haut de liste, la boîte s'allonge vers le bas ; en bas, vers le haut.
      box.style.transformOrigin = list.scrollTop < 0 ? "50% 0%" : "50% 100%";
      box.style.scale = `1 ${1 + k}`;
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(apply);
    };
    list.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      list.removeEventListener("scroll", onScroll);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [menuRef]);

  // La liste ne défile au doigt que si elle a de quoi défiler (voir `[data-scrolls]`, globals.css) :
  // ailleurs, le doigt reste au geste du menu. Relu à chaque rendu — une vue chasse l'autre.
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    if (list.scrollHeight > list.clientHeight + 1) list.setAttribute("data-scrolls", "");
    else list.removeAttribute("data-scrolls");
  });

  // Une autre vue dans la même surface : le contenu arrive en fondu, et la surface qui grandit se
  // déroule vers le haut au lieu de sauter.
  useLayoutEffect(() => {
    const box = menuRef.current;
    if (!box || view === firstView.current) return;
    firstView.current = view;
    const g = geometry.current;
    const before = g.height || box.offsetHeight;
    const after = box.offsetHeight;
    g.height = after;
    // Une nouvelle hauteur : la fermeture repartira de la bonne découpe.
    g.top = Math.max(0, after - (anchorRef.current?.offsetHeight ?? 0));
    if (!canAnimate() || prefersReducedMotion()) return;
    if (after > before) {
      box.animate([{ clipPath: `inset(${after - before}px 0px 0px 0px round ${RADIUS}px)` }, { clipPath: `inset(0px 0px 0px 0px round ${RADIUS}px)` }], {
        duration: 220,
        easing: "cubic-bezier(0.22, 1, 0.36, 1)",
      });
    }
    listRef.current?.animate([{ opacity: 0, transform: "translateY(4px)" }, { opacity: 1, transform: "none" }], { duration: 160, easing: "ease-out" });
  }, [view, menuRef, anchorRef]);

  return (
    // `data-liquid-soft` : le menu bouge au doigt (geste liquide sans redirection de clic, voir
    // `PlayerControls`) ; ses lignes gardent leur clic, la liste son défilement.
    <div ref={menuRef} data-liquid-soft className={`${className} flex flex-col`} style={style} onClick={onClick} onClickCapture={onClickCapture}>
      {/* Un titre et non un bouton : le premier bouton du menu reste sa première entrée, celle que
          le clavier et la télécommande atteignent d'abord. */}
      <div className="player-menu-head">
        <span ref={iconRef} className="inline-flex" aria-hidden>
          {icon}
        </span>
        <span ref={titleRef} className="player-menu-title min-w-0 truncate">
          {title}
        </span>
      </div>
      <div ref={listRef} className="player-menu-list">
        {children}
      </div>
    </div>
  );
}
