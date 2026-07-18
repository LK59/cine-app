"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { LogOut, MoreHorizontal, Search, LayoutDashboard, Film, Tv, Bookmark, Download, Telescope, CalendarDays, Clock, Sparkles, BarChart2, Captions, ListChecks, PlayCircle, Activity, Settings, RefreshCw } from "lucide-react";
import { prefetchRoute } from "@/lib/prefetch";
import { useT } from "@/components/TranslationProvider";
import { hardRefreshApp } from "@/lib/pwaRefresh";

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
      <p className="mb-1.5 px-1 text-[10px] font-semibold uppercase tracking-wider text-slate-500">{title}</p>
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
              className={`flex flex-col items-center gap-1.5 rounded-xl p-3 text-center text-[11px] transition-colors ${
                active
                  ? "bg-accent-500/15 text-accent-400 ring-1 ring-accent-500/30"
                  : "text-slate-300 hover:bg-white/5"
              }`}
            >
              <Icon size={20} className={active ? "text-accent-400" : "text-slate-400"} />
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
  const [open, setOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const sheetRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const t = useT();

  const PINNED = [
    { href: "/",          label: t('nav.mobile.home'),    icon: LayoutDashboard },
    { href: "/radarr",    label: t('nav.mobile.movies'),  icon: Film },
    { href: "/sonarr",    label: t('nav.mobile.series'),  icon: Tv },
    { href: "/watchlist", label: t('nav.watchlist'),      icon: Bookmark },
  ];

  const SECTION_CONTENT = [
    { href: "/discover",        label: t('nav.discover'),         icon: Telescope },
    { href: "/recommendations", label: t('nav.recommendations'),  icon: Sparkles },
    { href: "/calendar",        label: t('nav.calendar'),         icon: CalendarDays },
    { href: "/timeline",        label: t('nav.timeline'),         icon: Clock },
    { href: "/stats",           label: t('nav.stats'),            icon: BarChart2 },
  ];

  const SECTION_GESTION = [
    { href: "/qbittorrent",  label: t('nav.qbittorrent'),  icon: Download },
    { href: "/parametres",   label: t('nav.settings'),     icon: Settings },
    { href: "/bazarr",       label: t('nav.bazarr'),       icon: Captions },
    { href: "/jackett",      label: t('nav.jackett'),      icon: Search },
    { href: "/jellyfin",     label: t('nav.jellyfin'),     icon: PlayCircle },
    { href: "/jellyseerr",   label: t('nav.jellyseerr'),   icon: ListChecks },
    { href: "/health",       label: t('nav.health'),       icon: Activity },
  ];

  // Close on navigation back
  useEffect(() => {
    if (!open) return;
    const handler = () => setOpen(false);
    window.addEventListener("popstate", handler);
    return () => window.removeEventListener("popstate", handler);
  }, [open]);

  // Reset inline styles when sheet reopens (cleanup from previous drag-close)
  useEffect(() => {
    if (open && sheetRef.current) {
      sheetRef.current.style.transform = "";
      sheetRef.current.style.transition = "";
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

      // Close on quick flick OR substantial drag
      if (velocity > 0.45 || dy > 150) {
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

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.replace("/login");
  }

  async function refresh() {
    if (refreshing) return;
    setRefreshing(true);
    await hardRefreshApp();
  }

  function openSearch() {
    window.dispatchEvent(new CustomEvent("open-search"));
  }

  function isActive(href: string) {
    if (href === "/") return pathname === "/";
    return pathname === href || pathname.startsWith(href + "/");
  }

  return (
    <>
      {/* Bottom bar */}
      <nav
        className="glass-panel fixed inset-x-0 z-40 flex items-stretch border-x-0 border-b-0 md:hidden"
        style={{
          bottom: "calc(env(safe-area-inset-bottom, 0px) * -1)",
          paddingBottom: "calc(env(safe-area-inset-bottom, 0px) * 2)",
        }}
      >
        <div className="flex w-full items-center justify-around px-1 py-1 [@media(max-height:500px)_and_(orientation:landscape)]:py-0.5">
          {PINNED.map(({ href, label, icon: Icon }) => {
            const active = isActive(href);
            return (
              <Link
                key={href}
                href={href}
                onTouchStart={() => prefetchRoute(href)}
                onMouseEnter={() => prefetchRoute(href)}
                className={`flex flex-1 flex-col items-center gap-0.5 py-1.5 text-[10px] rounded-lg transition-colors [@media(max-height:500px)_and_(orientation:landscape)]:flex-row [@media(max-height:500px)_and_(orientation:landscape)]:justify-center [@media(max-height:500px)_and_(orientation:landscape)]:gap-1.5 [@media(max-height:500px)_and_(orientation:landscape)]:py-1 ${
                  active ? "text-accent-400" : "text-slate-500"
                }`}
              >
                <Icon size={20} />
                <span className="truncate px-0.5 leading-tight [@media(max-height:500px)_and_(orientation:landscape)]:hidden">{label}</span>
              </Link>
            );
          })}

          {/* Search */}
          <button
            onClick={openSearch}
            className="flex flex-1 flex-col items-center gap-0.5 py-1.5 text-[10px] text-slate-500 rounded-lg transition-colors hover:text-white [@media(max-height:500px)_and_(orientation:landscape)]:flex-row [@media(max-height:500px)_and_(orientation:landscape)]:justify-center [@media(max-height:500px)_and_(orientation:landscape)]:gap-1.5 [@media(max-height:500px)_and_(orientation:landscape)]:py-1"
          >
            <Search size={20} />
            <span className="[@media(max-height:500px)_and_(orientation:landscape)]:hidden">{t('nav.mobile.search')}</span>
          </button>

          {/* More */}
          <button
            onClick={() => setOpen(true)}
            className={`flex flex-1 flex-col items-center gap-0.5 py-1.5 text-[10px] rounded-lg transition-colors [@media(max-height:500px)_and_(orientation:landscape)]:flex-row [@media(max-height:500px)_and_(orientation:landscape)]:justify-center [@media(max-height:500px)_and_(orientation:landscape)]:gap-1.5 [@media(max-height:500px)_and_(orientation:landscape)]:py-1 ${
              open ? "text-accent-400" : "text-slate-500"
            }`}
          >
            <MoreHorizontal size={20} />
            <span className="[@media(max-height:500px)_and_(orientation:landscape)]:hidden">{t('nav.mobile.more')}</span>
          </button>
        </div>
      </nav>

      {/* Overlay */}
      {open && (
        <div
          ref={overlayRef}
          className="fixed inset-0 z-50 bg-black/60 backdrop-blur-xs md:hidden"
          onClick={() => setOpen(false)}
          style={{ touchAction: "none" }}
        />
      )}

      {/* Bottom sheet */}
      <div
        ref={sheetRef}
        className={`fixed inset-x-0 bottom-0 z-50 md:hidden transition-transform duration-300 ease-out ${
          open ? "translate-y-0" : "translate-y-full"
        }`}
        style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
      >
        <div data-sheet-content className="glass-panel rounded-t-2xl border-x-0 border-b-0 overflow-y-auto overscroll-contain" style={{ maxHeight: "85dvh" }}>
          {/* Visual drag indicator */}
          <div className="flex cursor-grab justify-center px-4 pt-4 pb-3">
            <div className="h-1 w-12 rounded-full bg-white/30" />
          </div>
          <div className="px-4 pb-4">

          {/* Search bar shortcut */}
          <button
            onClick={() => { setOpen(false); openSearch(); }}
            className="mb-4 flex w-full items-center gap-3 rounded-xl border border-white/10 bg-white/5 px-4 py-2.5 text-sm text-slate-400 hover:bg-white/10 transition-colors"
          >
            <Search size={15} />
            <span className="flex-1 text-left">{t('nav.mobile.searchHint')}</span>
            <kbd className="rounded-sm bg-white/10 px-1.5 py-0.5 text-[10px] font-medium">⌘K</kbd>
          </button>

          <SheetSection title={t('nav.mobile.sectionContent')} items={SECTION_CONTENT} isActive={isActive} onClose={() => setOpen(false)} />
          <SheetSection title={t('nav.mobile.sectionManage')} items={SECTION_GESTION} isActive={isActive} onClose={() => setOpen(false)} />

          {/* Refresh + Logout */}
          <div className="mt-2 flex items-center gap-2">
            <button
              onClick={refresh}
              disabled={refreshing}
              className="flex flex-1 items-center justify-center gap-2 rounded-xl border border-white/10 py-3 text-sm text-slate-300 hover:bg-white/5 transition-colors disabled:opacity-60"
            >
              <RefreshCw size={16} className={refreshing ? "animate-spin" : ""} /> {t('common.refresh')}
            </button>
            <button
              onClick={logout}
              className="flex flex-1 items-center justify-center gap-2 rounded-xl border border-white/10 py-3 text-sm text-red-400 hover:bg-white/5 transition-colors"
            >
              <LogOut size={16} /> {t('nav.logout')}
            </button>
          </div>
          </div>{/* end px-4 pb-4 */}
        </div>
      </div>
    </>
  );
}
