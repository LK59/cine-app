"use client";

import { useSignOut } from "@/components/offline/useSignOut";
import { MIN_FLICK_PX } from "@/lib/useSwipeToDismiss";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { LogOut, MoreHorizontal, Search, RefreshCw } from "lucide-react";
import { prefetchRoute } from "@/lib/prefetch";
import { NAV_PARTS, NAV_ITEMS, NAV_BAR_HREFS, activeNavHref } from "@/components/navItems";
import { AccountPreferencesLink, BackToCinema } from "@/components/gestion/NavBridge";
import { useT } from "@/components/TranslationProvider";
import { hardRefreshApp } from "@/lib/pwaRefresh";
import { AppSignature } from "@/components/AppSignature";
import { LiquidNavPill, LiquidTabLabel, liquidTabClass } from "@/components/LiquidNavPill";
import { useIsShortViewport } from "@/lib/useIsMobile";

/** La clé de « Plus » sur la pilule : ce n'est pas une adresse, il ouvre la feuille. */
const MORE = "more";

/** Le clic qui suit un appui arrive dans cette fenêtre : au-delà, c'est un vrai clic à lui seul. */
const DOUBLE_FIRE_MS = 700;

function SheetSection({
  title,
  items,
  isActive,
  onClose,
}: {
  title: string;
  items: { href: string; label: string; icon: React.ElementType }[];
  isActive: (href: string) => boolean;
  onClose: () => void;
}) {
  return (
    <div className="mb-4">
      <p className="mb-1.5 px-1 text-[11px] font-semibold uppercase tracking-wider text-subtle">{title}</p>
      <div className="grid grid-cols-3 gap-1.5">
        {items.map(({ href, label, icon: Icon }) => {
          const active = isActive(href);
          return (
            <Link
              key={href}
              href={href}
              onTouchStart={() => prefetchRoute(href)}
              onMouseEnter={() => prefetchRoute(href)}
              onClick={onClose}
              aria-current={active ? "page" : undefined}
              className={`flex flex-col items-center gap-1.5 rounded-2xl p-3 text-center text-[11px] transition-colors ${
                active ? "bg-white/12 text-white" : "text-muted hover:bg-white/6"
              }`}
            >
              <Icon size={20} strokeWidth={active ? 2.3 : 1.8} className={active ? "text-white" : "text-muted"} />
              <span className="leading-tight">{label}</span>
            </Link>
          );
        })}
      </div>
    </div>
  );
}

export function MobileNav() {
  const pathname = usePathname();
  const router = useRouter();
  const short = useIsShortViewport();
  /** Quand le pointeur a déjà navigué — voir la garde du clic. */
  const handledAt = useRef(0);
  /** L'appui en cours a changé de page au contact (et non ouvert « Plus », ou rien). */
  const navigatedOnDown = useRef(false);
  const [open, setOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const sheetRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const t = useT();

  // Les entrées viennent de navItems : la barre du bas garde ses libellés courts, tout le reste
  // suit les groupes partagés avec la barre latérale, dans le même ordre.
  const MOBILE_LABELS: Record<string, string> = {
    // « / » tant que la vue d'ensemble y vivait ; elle est à /gestion depuis que le cinéma a pris
    // la racine, et la clé ne correspondait plus à rien — la barre affichait le libellé long.
    "/gestion": t('nav.mobile.home'),
    "/radarr": t('nav.mobile.movies'),
    "/sonarr": t('nav.mobile.series'),
    "/qbittorrent": t('nav.mobile.downloads'),
  };

  const PINNED = NAV_BAR_HREFS.map((href) => {
    const item = NAV_ITEMS.find((i) => i.href === href)!;
    return { href, label: MOBILE_LABELS[href] ?? t(item.navKey), icon: item.icon };
  });

  // Les deux parties de la feuille (DECISIONS.md §81), chacune à plat, moins ce que la barre du
  // bas montre déjà. Les sous-groupes de la barre latérale n'y sont pas : sur une grille de trois
  // colonnes, un intitulé de plus coûte une ligne sans rien apprendre.
  const SHEET_GROUPS = NAV_PARTS.map((part) => ({
    key: part.key,
    title: t(part.titleKey),
    items: part.groups
      .flatMap((group) => group.items)
      .filter((i) => !NAV_BAR_HREFS.includes(i.href))
      .map((i) => ({ href: i.href, label: t(i.navKey), icon: i.icon })),
  })).filter((group) => group.items.length > 0);

  // Close on navigation back
  useEffect(() => {
    if (!open) return;
    const handler = () => setOpen(false);
    window.addEventListener("popstate", handler);
    return () => window.removeEventListener("popstate", handler);
  }, [open]);

  // Reset inline styles when sheet reopens (cleanup from previous drag-close) — the overlay too:
  // a drag-close leaves `opacity: 0` written on it, and it now stays mounted.
  useEffect(() => {
    if (!open) return;
    for (const el of [sheetRef.current, overlayRef.current]) {
      if (!el) continue;
      el.style.transform = "";
      el.style.transition = "";
      el.style.opacity = "";
    }
  }, [open]);

  // Native-feeling drag: whole sheet is the gesture target.
  // Only intercepts downward swipes when inner content is scrolled to top.
  useEffect(() => {
    if (!open) return;
    const sheet = sheetRef.current;
    const overlay = overlayRef.current;
    if (!sheet) return;

    // The inner scrollable div carries this attribute
    const innerContent = sheet.querySelector<HTMLElement>("[data-sheet-content]");

    let startY = 0;
    let startTime = 0;
    let isDraggingSheet = false;

    const onStart = (e: TouchEvent) => {
      startY = e.touches[0].clientY;
      startTime = Date.now();
      isDraggingSheet = false;
      sheet.style.transition = "none";
      if (overlay) overlay.style.transition = "none";
    };

    const onMove = (e: TouchEvent) => {
      const dy = e.touches[0].clientY - startY;
      const scrollTop = innerContent?.scrollTop ?? 0;

      // Activate sheet drag when: pulling down AND content is at the top
      if (!isDraggingSheet && dy > 6 && scrollTop <= 0) {
        isDraggingSheet = true;
      }
      if (!isDraggingSheet) return;

      e.preventDefault(); // block pull-to-refresh
      const delta = Math.max(0, dy);
      sheet.style.transform = `translateY(${delta}px)`;
      if (overlay) overlay.style.opacity = String(Math.max(0, 1 - delta / 300));
    };

    const onEnd = (e: TouchEvent) => {
      if (!isDraggingSheet) return;
      isDraggingSheet = false;
      const dy = e.changedTouches[0].clientY - startY;
      const velocity = dy / Math.max(1, Date.now() - startTime); // px/ms

      // Close on quick flick OR substantial drag. Le seuil d'activation de 6 px ne suffit pas à
      // distinguer un coup de doigt d'un appui un peu glissé : même règle que les autres feuilles.
      if ((dy >= MIN_FLICK_PX && velocity > 0.45) || dy > 150) {
        sheet.style.transition = "transform 0.24s cubic-bezier(0.4, 0, 1, 1)";
        sheet.style.transform = "translateY(100%)";
        if (overlay) {
          overlay.style.transition = "opacity 0.24s ease-out";
          overlay.style.opacity = "0";
        }
        setTimeout(() => setOpen(false), 240);
      } else {
        // Smooth spring-back — iOS-feel, no overshoot
        sheet.style.transition = "transform 0.42s cubic-bezier(0.22, 1, 0.36, 1)";
        sheet.style.transform = "translateY(0)";
        if (overlay) {
          overlay.style.transition = "opacity 0.42s cubic-bezier(0.22, 1, 0.36, 1)";
          overlay.style.opacity = "1";
        }
      }
    };

    sheet.addEventListener("touchstart", onStart, { passive: true });
    sheet.addEventListener("touchmove", onMove, { passive: false });
    sheet.addEventListener("touchend", onEnd, { passive: true });
    return () => {
      sheet.removeEventListener("touchstart", onStart);
      sheet.removeEventListener("touchmove", onMove);
      sheet.removeEventListener("touchend", onEnd);
    };
  }, [open]);

  // Gardée : hors ligne, la déconnexion restait bloquée sur place — voir `signOut`.
  // La question des téléchargements de l'appareil d'abord, s'il y en a (`useSignOut`).
  const { logout, sheet: signOutSheet } = useSignOut();

  async function refresh() {
    if (refreshing) return;
    setRefreshing(true);
    await hardRefreshApp();
  }

  function openSearch() {
    window.dispatchEvent(new CustomEvent("open-search"));
  }

  const activeHref = activeNavHref(pathname);
  function isActive(href: string) {
    return activeHref === href;
  }
  // La lentille se pose sous « Plus » tant que la feuille est ouverte, sous l'onglet de la page
  // sinon — et nulle part sur une page que la feuille seule propose (le rail ne ment pas).
  const lensKey = open ? MORE : PINNED.some((p) => p.href === activeHref) ? activeHref : null;

  // Le geste de la pilule du cinéma (DECISIONS.md §45) : la page change au contact, et un glisser
  // qui finit sur un autre onglet l'ouvre au relâchement — à la place de la première, pour qu'un
  // seul retour suffise. Fini sur « Plus », il ouvre la feuille.
  const onDragSelect = (key: string) => {
    handledAt.current = Date.now();
    if (key === MORE) {
      setOpen(true);
      return;
    }
    if (navigatedOnDown.current) router.replace(key);
    else router.push(key);
  };

  return (
    <>
      {/* La barre du bas : la pilule du cinéma elle-même (`LiquidNavPill`, DECISIONS.md §45 et
          §81) — même verre, même lentille qui glisse d'un onglet à l'autre, même geste. Elle n'en
          avait que l'allure le matin du 13/10/2026 : un onglet allumé, sans lentille ni glisser.
          Quatre destinations et « Plus » ; la recherche est en tête de la feuille, avec le pont
          vers le cinéma. Des largeurs à la mesure des mots, et non cinq cases égales :
          « Téléchargements » ne tient pas dans un cinquième de téléphone. */}
      <nav
        aria-label={t("nav.label")}
        data-gestion-nav
        className="pointer-events-none fixed inset-x-0 z-40 flex justify-center px-4 md:hidden"
        style={{ bottom: `calc(env(safe-area-inset-bottom, 0px) + ${short ? "0.5rem" : "0.75rem"})` }}
      >
        <LiquidNavPill active={lensKey} onDragSelect={onDragSelect} compact={short} className="max-w-full">
          {() => (
            <>
              {PINNED.map(({ href, label, icon: Icon }) => {
                const active = isActive(href);
                return (
                  <Link
                    key={href}
                    href={href}
                    data-lens={href}
                    onTouchStart={() => prefetchRoute(href)}
                    onMouseEnter={() => prefetchRoute(href)}
                    // Au contact, comme au cinéma : sur téléphone, `click` arrive trois cents
                    // millisecondes après le doigt.
                    onPointerDown={(e) => {
                      navigatedOnDown.current = false;
                      if (e.pointerType === "mouse" && (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey)) return;
                      handledAt.current = Date.now();
                      if (active) return;
                      navigatedOnDown.current = true;
                      router.push(href);
                    }}
                    // Le clic reste celui du lien pour le clavier et les technologies d'assistance ;
                    // après un appui, il ferait naviguer une seconde fois.
                    onClick={(e) => {
                      if (Date.now() - handledAt.current < DOUBLE_FIRE_MS) e.preventDefault();
                    }}
                    // Au doigt, le lien ne prend pas le focus (même raison qu'au cinéma).
                    onMouseDown={(e) => e.preventDefault()}
                    aria-current={active ? "page" : undefined}
                    className={liquidTabClass({ compact: short, on: active, fit: true })}
                  >
                    <Icon size={short ? 19 : 20} strokeWidth={active ? 2.4 : 1.8} />
                    <LiquidTabLabel compact={short} on={active} fit>{label}</LiquidTabLabel>
                  </Link>
                );
              })}

              {/* Plus — au clic et non au contact : la feuille et son voile apparaîtraient sous le
                  doigt, et le clic qui suit tomberait sur le voile, qui la referme. */}
              <button
                type="button"
                data-lens={MORE}
                onPointerDown={() => {
                  navigatedOnDown.current = false;
                }}
                onClick={() => setOpen(true)}
                onMouseDown={(e) => e.preventDefault()}
                aria-expanded={open}
                className={liquidTabClass({ compact: short, on: open, fit: true })}
              >
                <MoreHorizontal size={short ? 19 : 20} strokeWidth={open ? 2.4 : 1.8} />
                <LiquidTabLabel compact={short} on={open} fit>{t("nav.mobile.more")}</LiquidTabLabel>
              </button>
            </>
          )}
        </LiquidNavPill>
      </nav>

      {/* Overlay — toujours monté, pour fondre avec la feuille au lieu d'apparaître et de
          disparaître d'un coup pendant qu'elle glisse (23/09/2026). Caché (`invisible`) une fois
          son fondu fini : un voile transparent garderait sinon son flou sur tout l'écran, et ses
          clics. */}
      <div
        ref={overlayRef}
        aria-hidden
        className={`fixed inset-0 z-50 bg-black/60 backdrop-blur-xs transition-[opacity,visibility] duration-300 md:hidden ${
          open ? "visible opacity-100" : "pointer-events-none invisible opacity-0"
        }`}
        onClick={() => setOpen(false)}
        style={{ touchAction: "none" }}
      />

      {/* Bottom sheet */}
      <div
        ref={sheetRef}
        className={`fixed inset-x-0 bottom-0 z-50 md:hidden transition-transform duration-300 ease-out ${
          open ? "translate-y-0" : "translate-y-full"
        }`}
        style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
      >
        <div data-sheet-content className="glass-panel overflow-y-auto overscroll-contain rounded-t-2xl border-x-0 border-b-0" style={{ maxHeight: "85dvh" }}>
          {/* Visual drag indicator */}
          <div className="flex cursor-grab justify-center px-4 pt-4 pb-3">
            <div className="h-1 w-12 rounded-full bg-white/30" />
          </div>
          <div className="px-4 pb-4">

          {/* Le pont vers le cinéma, en tête comme sur la barre latérale (DECISIONS.md §81). */}
          <BackToCinema className="mb-3" onNavigate={() => setOpen(false)} />

          <button
            type="button"
            onClick={() => { setOpen(false); openSearch(); }}
            className="mb-4 flex w-full items-center gap-3 rounded-full bg-white/6 px-4 py-2.5 text-sm text-muted transition-colors hover:bg-white/10"
          >
            <Search size={15} />
            <span className="flex-1 text-left">{t('nav.mobile.searchHint')}</span>
          </button>

          {SHEET_GROUPS.map((group) => (
            <SheetSection key={group.key} title={group.title} items={group.items} isActive={isActive} onClose={() => setOpen(false)} />
          ))}

          <AccountPreferencesLink className="mb-4 px-1" onNavigate={() => setOpen(false)} />

          {/* Refresh + Logout */}
          <div className="mt-2 flex items-center gap-2">
            <button
              onClick={refresh}
              disabled={refreshing}
              className="btn btn-ghost flex-1 rounded-full py-3"
            >
              <RefreshCw size={16} className={refreshing ? "animate-spin" : ""} /> {t('common.refresh')}
            </button>
            <button
              onClick={logout}
              className="btn btn-ghost flex-1 rounded-full py-3 text-danger"
            >
              <LogOut size={16} /> {t('nav.logout')}
            </button>
            {signOutSheet}
          </div>

          {/* Le pendant de la barre latérale du bureau, qui n'existe pas ici : la gestion sur
              téléphone n'a que cette feuille, et sa dernière ligne est l'endroit le plus discret
              (DECISIONS.md §41). La marge de l'indicateur d'accueil est déjà celle de la feuille. */}
          <AppSignature className="mt-4 text-center" />
          </div>{/* end px-4 pb-4 */}
        </div>
      </div>
    </>
  );
}
