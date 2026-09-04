"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Clapperboard, LogOut, MonitorPlay, Search } from "lucide-react";
import { NAV_GROUPS } from "@/components/navItems";
import { useRole } from "@/lib/useRole";
import { prefetchRoute } from "@/lib/prefetch";
import { useT } from "@/components/TranslationProvider";
import { enterCinema } from "@/lib/leaveCinema";

export function Sidebar() {
  const pathname = usePathname();
  const router = useRouter();
  const { isGuest } = useRole();
  const t = useT();

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
        {isGuest && <span className="badge bg-white/5 text-[10px] text-slate-400">{t('nav.guest')}</span>}
      </div>

      {/* Search shortcut */}
      <button
        onClick={() => {
          document.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true }));
        }}
        className="mb-3 flex shrink-0 w-full items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-slate-400 hover:bg-white/10 hover:text-slate-200"
      >
        <Search size={14} />
        <span className="flex-1 text-left text-xs">{t('nav.searchPlaceholder')}</span>
        <kbd className="text-[10px] text-slate-600">⌘K</kbd>
      </button>

      {/* Distinct entry point, not folded into NAV_ITEMS below — this leaves the whole standard
          shell (own layout, own visual language) for /cinema, a genuinely different mode rather
          than just another page.

          It was a plain <a> (a full page load) for months, because the client-side transition to
          this route was failing in production. It works again — see enterCinema, which also
          carries the fallback that covers a click landing mid-redeploy. */}
      <button
        type="button"
        onClick={() => enterCinema(router)}
        className="btn btn-ghost mb-3 w-full shrink-0 justify-start px-3 py-2 text-accent-300"
      >
        <MonitorPlay size={16} />
        {t("nav.cinemaMode")}
      </button>

      {/* Scrollable nav list */}
      {/* La liste défile quand elle ne tient pas, et jusqu'ici une entrée coupée net en haut ou
          en bas ressemblait à un défaut de mise en page plutôt qu'à « il y en a plus ». Le
          dégradé de masque le dit sans rien ajouter au DOM. Les entrées sont aussi un peu plus
          serrées, ce qui suffit à faire tenir la liste entière sur la plupart des écrans. */}
      <nav
        className="flex-1 overflow-y-auto overscroll-contain"
        style={
          {
            scrollbarWidth: "none",
            WebkitOverflowScrolling: "touch",
            maskImage: "linear-gradient(to bottom, transparent, black 12px, black calc(100% - 12px), transparent)",
            WebkitMaskImage: "linear-gradient(to bottom, transparent, black 12px, black calc(100% - 12px), transparent)",
          } as React.CSSProperties
        }
      >
        {/* Les mêmes groupes que le téléphone, avec leur intitulé : seize entrées d'affilée sans
            respiration, c'est une liste où l'on cherche au lieu de reconnaître. */}
        <div className="pb-2">
          {NAV_GROUPS.map((group, groupIndex) => (
          <div key={group.titleKey} className={groupIndex > 0 ? "mt-4" : ""}>
          <p className="mb-1 px-4 text-[10px] font-semibold uppercase tracking-wider text-slate-600">
            {t(group.titleKey)}
          </p>
          <div className="space-y-0.5">
          {group.items.map(({ href, navKey, icon: Icon }) => {
            const active = pathname === href;
            return (
              <Link
                key={href}
                href={href}
                onMouseEnter={() => prefetchRoute(href)}
                onFocus={() => prefetchRoute(href)}
                /* Un repère fin à gauche et du texte plus clair, plutôt qu'un pavé violet.
                   L'accent était le fond de l'entrée active, l'encadré du mode cinéma, le bouton
                   principal, la puce sélectionnée et l'icône de chaque section : une couleur qui
                   veut dire six choses n'en dit plus aucune. Ici deux de ces pavés se touchaient
                   et se disputaient l'œil. */
                className={`relative flex items-center gap-3 rounded-lg py-1.5 pl-4 pr-3 text-sm font-medium transition-colors ${
                  active
                    ? "text-white before:absolute before:left-0 before:top-1/2 before:h-5 before:w-[3px] before:-translate-y-1/2 before:rounded-full before:bg-accent-500"
                    : "text-slate-400 hover:bg-white/5 hover:text-slate-100"
                }`}
              >
                <Icon size={18} className="shrink-0" />
                <span className="truncate">{t(navKey)}</span>
              </Link>
            );
          })}
          </div>
          </div>
          ))}
        </div>
      </nav>

      {/* Logout */}
      <button
        onClick={logout}
        className="btn mt-2 w-full shrink-0 justify-start gap-3 px-3 py-2 text-slate-400 hover:bg-white/5 hover:text-red-400"
      >
        <LogOut size={18} className="shrink-0" />
        <span className="truncate">{t('nav.logout')}</span>
      </button>
    </aside>
  );
}
