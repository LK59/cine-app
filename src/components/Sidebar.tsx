"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Clapperboard, LogOut, Search } from "lucide-react";
import { NAV_ITEMS } from "@/components/navItems";
import { useRole } from "@/lib/useRole";
import { prefetchRoute } from "@/lib/prefetch";

export function Sidebar() {
  const pathname = usePathname();
  const router = useRouter();
  const { isGuest } = useRole();

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.replace("/login");
  }

  return (
    <aside className="glass-panel hidden h-full w-64 flex-col border-r border-l-0 border-y-0 px-3 py-4 md:flex">
      {/* Logo */}
      <div className="mb-6 flex shrink-0 items-center gap-3 px-2">
        <div className="rounded-lg bg-accent-600/20 p-2 text-accent-400 ring-1 ring-inset ring-white/10">
          <Clapperboard size={20} />
        </div>
        <span className="text-base font-semibold text-white">Cine App</span>
        {isGuest && <span className="badge bg-white/5 text-[10px] text-slate-400">Invité</span>}
      </div>

      {/* Search shortcut */}
      <button
        onClick={() => {
          document.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true }));
        }}
        className="mb-3 flex shrink-0 w-full items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-slate-400 hover:bg-white/10 hover:text-slate-200"
      >
        <Search size={14} />
        <span className="flex-1 text-left text-xs">Rechercher…</span>
        <kbd className="text-[10px] text-slate-600">⌘K</kbd>
      </button>

      {/* Scrollable nav list */}
      <nav
        className="flex-1 overflow-y-auto overscroll-contain"
        style={{ scrollbarWidth: "none", WebkitOverflowScrolling: "touch" } as React.CSSProperties}
      >
        <div className="space-y-0.5 pb-2">
          {NAV_ITEMS.map(({ href, label, icon: Icon }) => {
            const active = pathname === href;
            return (
              <Link
                key={href}
                href={href}
                onMouseEnter={() => prefetchRoute(href)}
                onFocus={() => prefetchRoute(href)}
                className={`flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium backdrop-blur-sm transition-colors ${
                  active
                    ? "bg-accent-600/15 text-accent-400 ring-1 ring-inset ring-accent-500/20"
                    : "text-slate-400 hover:bg-white/5 hover:text-slate-100"
                }`}
              >
                <Icon size={18} className="shrink-0" />
                <span className="truncate">{label}</span>
              </Link>
            );
          })}
        </div>
      </nav>

      {/* Logout */}
      <button
        onClick={logout}
        className="mt-2 flex shrink-0 items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium text-slate-400 hover:bg-white/5 hover:text-red-400"
      >
        <LogOut size={18} className="shrink-0" />
        <span className="truncate">Déconnexion</span>
      </button>
    </aside>
  );
}
