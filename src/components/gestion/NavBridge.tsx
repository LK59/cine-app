"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, UserRound } from "lucide-react";
import { useT } from "@/components/TranslationProvider";
import { enterCinema } from "@/lib/leaveCinema";
import { ACCOUNT_PREFERENCES_HREF } from "@/components/navItems";

/**
 * Le pont de la gestion vers le cinéma (DECISIONS.md §81) — un seul passage dans chaque sens :
 * « Retour au cinéma » ici, en tête de la navigation, « Ouvrir la gestion » dans le panneau Compte.
 *
 * Par `enterCinema` et non un lien nu : la transition garde le lecteur monté (un film réduit
 * continue), et retombe sur un rechargement si le clic tombe pendant un redéploiement.
 */
export function BackToCinema({ className = "", onNavigate }: { className?: string; onNavigate?: () => void }) {
  const t = useT();
  const router = useRouter();
  return (
    <button
      type="button"
      data-nav-bridge
      onClick={() => {
        onNavigate?.();
        enterCinema(router);
      }}
      className={`nav-glass flex w-full shrink-0 items-center gap-2.5 rounded-full px-4 py-2.5 text-sm font-semibold text-white ${className}`}
    >
      <ArrowLeft size={16} className="shrink-0" />
      {t("nav.backToCinema")}
    </button>
  );
}

/**
 * Ce qui est à l'administrateur lui-même — langue, notifications, sessions — vit dans le Compte du
 * cinéma, comme pour tout autre compte. La gestion n'en garde que ce lien, discret.
 */
export function AccountPreferencesLink({ className = "", onNavigate }: { className?: string; onNavigate?: () => void }) {
  const t = useT();
  return (
    <Link
      href={ACCOUNT_PREFERENCES_HREF}
      onClick={onNavigate}
      data-account-preferences
      className={`flex items-center gap-1.5 text-xs text-subtle transition-colors hover:text-muted ${className}`}
    >
      <UserRound size={13} className="shrink-0" />
      {t("nav.accountPreferences")}
    </Link>
  );
}
