import type { Metadata } from "next";
import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { SESSION_COOKIE } from "@/lib/auth";
import { verifySessionFull } from "@/lib/session";
import { config } from "@/lib/config";
import { APP_NAME } from "@/lib/appBuild";
import { BooksScreenLazy } from "@/components/books/BooksScreenLazy";

/**
 * La page des livres (option, DECISIONS.md §127).
 *
 * Hors du groupe `(player)` : sa coquille lance le catalogue des films avec le HTML et monte la
 * navigation du cinéma, rien dont un lecteur de livres ait besoin — et l'option ne doit rien changer
 * à ce que le cinéma fait. Ici, seulement la racine (traductions, préférences) et l'écran des livres.
 *
 * Option coupée : la page n'existe pas (404). Sans session : la connexion. Une session de lien de
 * partage n'arrive jamais ici — le proxy la renvoie à sa fiche (`shareGate`, §112) ; le redire coûte
 * une ligne.
 *
 * Sa politique de sécurité est la sienne (`next.config.js`) : elle permet les cadres `blob:` du
 * lecteur, et c'est aussi celle dont héritent les chapitres affichés dedans.
 */
export const metadata: Metadata = { title: APP_NAME };

export default async function BooksPage() {
  if (config.books.enabled !== true) notFound();
  const session = await verifySessionFull((await cookies()).get(SESSION_COOKIE)?.value);
  if (!session) redirect("/login?next=/livres");
  if (session.role === "share") redirect("/");
  return <BooksScreenLazy />;
}
