"use client";

import { useSignOut } from "@/components/offline/useSignOut";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Clapperboard, LogOut, Search } from "lucide-react";
import { NAV_PARTS, activeNavHref } from "@/components/navItems";
import { prefetchRoute } from "@/lib/prefetch";
import { useT } from "@/components/TranslationProvider";
import { useConfiguredServices } from "@/lib/useConfiguredServices";
import { AppSignature } from "@/components/AppSignature";
import { APP_NAME } from "@/lib/appBuild";
import { AccountPreferencesLink, BackToCinema } from "@/components/gestion/NavBridge";

/**
 * La navigation de la gestion sur grand écran (refaite le 13/10/2026, DECISIONS.md §81).
 *
 * La langue du cinéma : un panneau de verre posé sur le noir, des entrées en pilule, l'entrée
 * active éclairée comme la lentille de la barre du cinéma. L'ancienne barre était une colonne
 * pleine hauteur collée au bord, avec un repère violet à gauche — l'autre interface de la même
 * application avait l'air d'un autre produit.
 *
 * En tête, le pont vers le cinéma : c'est le seul passage dans ce sens, comme « Ouvrir la gestion »
 * est le seul dans l'autre (panneau Compte). Puis les deux parties, Infrastructure et
 * Configuration ; et sous Configuration, le lien vers ce qui est à l'administrateur lui-même —
 * sa langue, ses notifications, ses sessions — qui vit dans le Compte du cinéma.
 */
export function Sidebar() {
  const pathname = usePathname();
  const t = useT();
  const { isConfigured } = useConfiguredServices();
  const active = activeNavHref(pathname);

  // Gardée : hors ligne, la déconnexion restait bloquée sur place — voir `signOut`.
  // La question des téléchargements de l'appareil d'abord, s'il y en a (`useSignOut`).
  const { logout, sheet: signOutSheet } = useSignOut();

  return (
    <aside className="hidden h-full w-64 shrink-0 p-3 pr-0 md:flex">
      <div className="glass-sheen flex min-h-0 w-full flex-col rounded-2xl px-3 py-4">
        <BackToCinema className="mb-4" />

        <div className="mb-4 flex shrink-0 items-center gap-2.5 px-2">
          <Clapperboard size={20} className="text-brand" aria-hidden />
          <span className="text-base font-semibold text-white">{APP_NAME}</span>
        </div>

        <button
          type="button"
          onClick={() => {
            document.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true }));
          }}
          className="mb-3 flex w-full shrink-0 items-center gap-2 rounded-full bg-white/6 px-3 py-2 text-sm text-muted transition-colors hover:bg-white/10 hover:text-white"
        >
          <Search size={14} />
          <span className="flex-1 text-left text-xs">{t("nav.searchPlaceholder")}</span>
          <kbd className="text-[11px] text-subtle">⌘K</kbd>
        </button>

        {/* La liste défile quand elle ne tient pas ; le dégradé de masque le dit sans rien ajouter
            au DOM — une entrée coupée net ressemblait à un défaut de mise en page. */}
        <nav
          aria-label={t("nav.label")}
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
          style={
            {
              scrollbarWidth: "none",
              maskImage: "linear-gradient(to bottom, transparent, black 12px, black calc(100% - 12px), transparent)",
              WebkitMaskImage: "linear-gradient(to bottom, transparent, black 12px, black calc(100% - 12px), transparent)",
            } as React.CSSProperties
          }
        >
          {/* pt-3 : le masque efface les douze premiers pixels ; le premier intitulé y tombait. */}
          <div className="pb-2 pt-3">
            {NAV_PARTS.map((part, partIndex) => (
              <div key={part.key} data-nav-part={part.key} className={partIndex > 0 ? "mt-5" : ""}>
                <p className="mb-1.5 px-3 text-[11px] font-semibold uppercase tracking-wider text-subtle">{t(part.titleKey)}</p>
                {part.groups.map((group, groupIndex) => (
                  <div key={group.titleKey ?? groupIndex} className={groupIndex > 0 ? "mt-3" : ""}>
                    {group.titleKey && <p className="mb-1 px-3 text-[11px] text-subtle">{t(group.titleKey)}</p>}
                    <div className="space-y-0.5">
                      {group.items.map(({ href, navKey, icon: Icon, service }) => {
                        const on = active === href;
                        // Une page dont le service n'est pas branché reste accessible — elle explique
                        // alors quoi régler — mais cesse de se présenter comme une destination
                        // ordinaire. L'estomper vaut mieux que la retirer.
                        const off = !!service && !isConfigured(service);
                        return (
                          <Link
                            key={href}
                            href={href}
                            onMouseEnter={() => prefetchRoute(href)}
                            onFocus={() => prefetchRoute(href)}
                            aria-current={on ? "page" : undefined}
                            title={off ? t("services.notConfigured", { name: t(navKey) }) : undefined}
                            className={`flex items-center gap-3 rounded-full px-3 py-1.5 text-sm font-medium transition-colors ${
                              on ? "bg-white/12 text-white" : "text-muted hover:bg-white/6 hover:text-white"
                            } ${off ? "opacity-40" : ""}`}
                          >
                            <Icon size={17} strokeWidth={on ? 2.3 : 1.8} className="shrink-0" />
                            <span className="truncate">{t(navKey)}</span>
                          </Link>
                        );
                      })}
                    </div>
                  </div>
                ))}
                {part.key === "configuration" && <AccountPreferencesLink className="mt-3 px-3" />}
              </div>
            ))}
          </div>
        </nav>

        <button
          type="button"
          onClick={logout}
          className="mt-2 flex w-full shrink-0 items-center gap-3 rounded-full px-3 py-2 text-sm text-muted transition-colors hover:bg-white/6 hover:text-danger"
        >
          <LogOut size={17} className="shrink-0" />
          <span className="truncate">{t("nav.logout")}</span>
        </button>
        {signOutSheet}

        {/* Sous « Déconnexion », hors de la liste qui défile : toujours au même endroit, jamais
            sous le masque de fondu (DECISIONS.md §41). */}
        <AppSignature className="mt-2 shrink-0 px-3" />
      </div>
    </aside>
  );
}
