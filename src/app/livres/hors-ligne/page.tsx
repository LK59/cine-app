import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { config } from "@/lib/config";
import { APP_NAME } from "@/lib/appBuild";
import { OfflineBooksScreenLazy } from "@/components/books/OfflineBooksScreenLazy";

/**
 * Les livres gardés sur l'appareil, lisibles sans réseau (option, DECISIONS.md §127).
 *
 * Publique (`PUBLIC_PATHS`), comme l'entrée hors ligne des films : le service worker la demande sans
 * cookie pour la garder avec le code de son build, et la sert quand le serveur ne répond pas. Rendue
 * sans session, elle ne porte rien d'un compte : elle lit le dossier du compte retenu sur l'appareil.
 * Option coupée : elle n'existe pas. Sa politique de sécurité est celle des livres (`next.config.js`).
 */
export const metadata: Metadata = { title: APP_NAME };

export default function OfflineBooksPage() {
  if (config.books.enabled !== true) notFound();
  return <OfflineBooksScreenLazy />;
}
