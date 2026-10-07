"use client";

import { useLayoutEffect, useRef, type CSSProperties, type ReactNode, type RefObject } from "react";
import { LIQUID_SPRING, prefersReducedMotion, toSpring } from "@/lib/liquidGlass/liquid";
import { simulateSpring, springKeyframes } from "@/lib/liquidGlass/spring";

/**
 * Un menu du lecteur, né de la pilule des réglages (DECISIONS.md §45).
 *
 * Une seule surface qui change de forme : découpée au départ exactement à la pilule (même verre,
 * même place — la pilule s'efface dessous), elle s'ouvre vers le haut et la gauche sur le ressort.
 * L'icône, le titre et les lignes apparaissent en fondu à leur place — portés par le contenu,
 * jamais par la surface floutée, et sans bouger dans la boîte.
 *
 * **La fermeture ne retarde rien.** Le menu se démonte à l'instant où il se ferme, comme avant :
 * le focus, le clavier, ce que les tests lisent, rien ne change. Ce qui se referme à l'écran est
 * une copie inerte, posée à sa place au démontage et retirée une fois le geste fini — rapide
 * (180 ms), depuis l'état où il était : un toucher à côté *pendant* l'ouverture le referme d'où il
 * en est, sans attendre la fin du ressort (demandé le 04/10/2026). La pilule revient quand le
 * menu a retrouvé sa forme, en fondu croisé.
 *
 * Changer de vue (⋮ → minuterie) garde la surface : si elle grandit, elle se déroule vers le haut.
 */

const CLOSE_MS = 180;
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
 * Pendant qu'elle s'ouvre, la boîte s'allonge dans le sens où elle part — vers le haut — et se
 * resserre un peu en largeur, puis reprend sa forme en se posant : la matière des menus d'iOS
 * récents, plutôt qu'une forme rigide qu'on agrandit (07/10/2026). Proportionnel à la vitesse du
 * ressort rapportée à son pic : une bosse qui monte en trois images jusqu'à 3 % et redescend avec
 * elle. La première version multipliait la vitesse par une constante et la bornait à 4 % : la
 * vitesse du ressort dépasse ce plafond dès la première image, si bien que l'étirement sautait
 * d'un coup à 4 %, y restait 120 ms, puis repartait — une marche, lue comme une saccade.
 */
const OPEN_STRETCH_PEAK = 0.03;
const OPEN_PEAK_SPEED = Math.max(...simulateSpring(0, 1, OPEN_SPRING).map((s) => s.v));
/**
 * Les lignes arrivent l'une après l'autre, de haut en bas, 18 ms d'écart : la liste se déplie au
 * lieu de s'allumer d'un bloc. Seules les lignes visibles s'animent, huit au plus : chacune prend
 * un calque le temps de son entrée, et celles cachées sous le bas de la liste n'ont rien à montrer.
 */
const ROW_STAGGER_MS = 18;
const ROW_STAGGER_MAX = 8;

/** L'étirement d'une vitesse d'ouverture `v` (fractions d'ouverture par seconde). */
export function openStretch(v: number) {
  return Math.max(-OPEN_STRETCH_PEAK / 2, Math.min(OPEN_STRETCH_PEAK, (v / OPEN_PEAK_SPEED) * OPEN_STRETCH_PEAK));
}

/**
 * La pilule telle qu'on la voit, exprimée depuis le coin bas-droit du menu. Touchée, elle est
 * encore gonflée par le geste liquide (transformée autour de son centre) quand le menu naît : partir
 * de sa forme au repos faisait sauter la surface à la première image. `null` si elle est au repos.
 */
function pillHandover(anchor: HTMLElement): DOMMatrix | null {
  if (typeof DOMMatrix === "undefined") return null;
  const t = getComputedStyle(anchor).transform;
  if (!t || t === "none") return null;
  const m = new DOMMatrix(t);
  if (m.isIdentity) return null;
  // Autour du centre C de la pilule, devenu autour du coin O : t' = (I − M)(C − O) + t.
  const cx = -anchor.offsetWidth / 2;
  const cy = -anchor.offsetHeight / 2;
  return new DOMMatrix([m.a, m.b, m.c, m.d, cx - (m.a * cx + m.c * cy) + m.e, cy - (m.b * cx + m.d * cy) + m.f]);
}

/** `from` amené vers l'identité à mesure que `q` va de 0 à 1. */
function easeOff(from: DOMMatrix | null, q: number) {
  if (!from) return "";
  const r = 1 - Math.min(Math.max(q, 0), 1);
  return `matrix(${1 + (from.a - 1) * r}, ${from.b * r}, ${from.c * r}, ${1 + (from.d - 1) * r}, ${from.e * r}, ${from.f * r}) `;
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
      openMorph(box, anchor);
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

    function openMorph(box: HTMLDivElement, anchor: HTMLElement) {
    box.setAttribute("data-morph", "");
    const W = box.offsetWidth;
    const H = box.offsetHeight;
    const g = geometry.current;
    g.top = Math.max(0, H - anchor.offsetHeight);
    g.left = Math.max(0, W - anchor.offsetWidth);
    g.pillRadius = anchor.offsetHeight / 2;
    g.height = H;

    // Une seule animation pour la découpe et la forme, et c'est voulu. La découpe ne se joue que
    // sur le fil principal — à 60 images par seconde au plus sous Safari, même sur un écran à
    // 120 Hz — et une transformation à part partait au compositeur, à 120 : les bords de la boîte
    // et ce qu'elle contient n'avançaient plus au même rythme, ce qui se lisait comme des images
    // manquantes (8.15.7, 07/10/2026). Ensemble, elles avancent d'un même pas. Une découpe jouée
    // par le compositeur a été essayée (fenêtres imbriquées, translations opposées) : sous Chromium,
    // le flou du verre ne suit pas les coins arrondis des ancêtres, deux coins restaient carrés.
    const handover = pillHandover(anchor);
    const shape = springKeyframes(0, 1, OPEN_SPRING, ({ x, v }) => {
      // Le dépassement ne peut pas agrandir la découpe au-delà de la boîte : il passe en échelle,
      // depuis le coin d'où le menu naît. Au repos, l'origine revient au centre : c'est d'elle que
      // le geste liquide gonfle et étire la surface.
      const pop = 1 + Math.max(0, x - 1) * OPEN_BOUNCE;
      const k = openStretch(v);
      return {
        clipPath: clipAt(x, g.top, g.left, g.pillRadius),
        transform: `${easeOff(handover, x)}scale(${pop * (1 - k / 2)}, ${pop * (1 + k)})`,
        transformOrigin: "100% 100%",
      };
    });
    box.animate(shape.keyframes, { duration: shape.duration, easing: "linear" });

    // Le contenu ne bouge pas dans la boîte : il apparaît en fondu, à sa place. L'icône glissait du
    // bouton touché jusqu'à l'en-tête et arrivait après que la boîte s'était posée — elle bougeait
    // encore dedans (07/10/2026). Des fondus et rien d'autre : un déplacement, joué au compositeur,
    // n'avancerait pas au rythme de la découpe.
    const fadeIn = (el: Element | null, delay: number, duration = 160) =>
      el?.animate([{ opacity: 0 }, { opacity: 1 }], { duration, delay, easing: "ease-out", fill: "backwards" });
    fadeIn(iconRef.current, 30);
    fadeIn(titleRef.current, 30);
    // Ligne par ligne, de haut en bas, 18 ms d'écart.
    const listBox = listRef.current;
    const rows = listBox ? Array.from(listBox.children).filter((row) => (row as HTMLElement).offsetTop - listBox.offsetTop - listBox.scrollTop < listBox.clientHeight).slice(0, ROW_STAGGER_MAX) : [];
    rows.forEach((row, i) => fadeIn(row, 50 + i * ROW_STAGGER_MS, 180));

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
      const computed = getComputedStyle(box);
      const clip = computed.clipPath;
      // Et sa forme en cours : refermé pendant l'ouverture, il est encore étiré (ou gonflé par la
      // pilule) — repartir d'une échelle 1 le faisait sauter.
      const shapeNow = computed.transform && computed.transform !== "none" ? computed.transform : "none";
      const originNow = computed.transformOrigin;
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
      ghost.style.transformOrigin = originNow;
      host.insertBefore(ghost, box.nextSibling);
      const list = ghost.querySelector<HTMLElement>(".player-menu-list");
      if (list && listEl) list.scrollTop = listEl.scrollTop;
      const geo = { ...g };
      // Découpe et forme ensemble, comme à l'ouverture : d'un même pas.
      ghost.animate(
        [
          { clipPath: clipAt(p0, geo.top, geo.left, geo.pillRadius), transform: shapeNow },
          { clipPath: clipAt(0, geo.top, geo.left, geo.pillRadius), transform: "none" },
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
