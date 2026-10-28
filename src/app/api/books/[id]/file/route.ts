import { NextRequest, NextResponse } from "next/server";
import { logError } from "@/lib/logger";
import { config } from "@/lib/config";
import { jellyfinAuthHeaders } from "@/lib/jellyfinAuth";
import { passJellyfinFetch } from "@/lib/jellyfinBreaker";
import { jellyfinIdSegment } from "@/lib/jellyfinPath";
import { bookIdOf, booksCaller } from "@/lib/books/guard";
import { bookFor } from "@/lib/books/library";

/**
 * Le fichier EPUB d'un livre (option, DECISIONS.md §127), relayé depuis `/Items/{id}/Download`.
 *
 * Signé avec la clé du serveur — un compte ordinaire n'a souvent pas le droit de télécharger chez
 * Jellyfin, et le lecteur n'est pas un téléchargement : le fichier ne quitte pas la page. D'où la
 * vérification **avant** : l'élément doit être un livre que ce compte voit (`bookFor` — droits Jellyfin
 * du compte et tags bloqués de l'application). Un film ou un épisode demandé ici répond 404 : cette
 * route ne relaie que des livres.
 *
 * `?telecharger=1` (bouton « Fichier EPUB » de la fiche, hors application installée — 29/10/2026) : le
 * même fichier, en pièce jointe nommée « Titre - Auteur.epub », pour une liseuse (câble, Calibre…).
 *
 * Rien de la réponse de Jellyfin n'est recopié hormis le type et la taille : ni ses en-têtes, ni son
 * adresse, ni la clé. `private` : la réponse dépend du compte qui la demande.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const caller = await booksCaller(req);
  if (caller instanceof NextResponse) return caller;
  const id = bookIdOf((await params).id);
  if (!id) return new NextResponse(null, { status: 400 });

  let visible;
  try {
    visible = await bookFor(caller, id);
  } catch {
    return new NextResponse(null, { status: 502 });
  }
  if (!visible) return new NextResponse(null, { status: 404 });

  let upstream: Response;
  try {
    upstream = await passJellyfinFetch(`${config.jellyfin.url}/Items/${jellyfinIdSegment(id)}/Download`, {
      headers: jellyfinAuthHeaders(config.jellyfin.apiKey),
      signal: req.signal,
      cache: "no-store",
    });
  } catch {
    return new NextResponse(null, { status: 502 });
  }
  if (!upstream.ok || !upstream.body) {
    // Dans `server.log` : un livre qui ne s'ouvre pas parce que Jellyfin ne le rend pas se distingue
    // ainsi d'un fichier que le lecteur ne sait pas lire (28/10/2026).
    logError("books/file", new Error(`Jellyfin a répondu ${upstream.status} au téléchargement`), { itemId: id });
    await upstream.body?.cancel().catch(() => {});
    return new NextResponse(null, { status: upstream.status === 404 ? 404 : 502 });
  }
  const headers: Record<string, string> = {
    // Le type d'un EPUB, quoi que Jellyfin annonce : la page ne s'en sert que pour le lire en mémoire.
    "Content-Type": "application/epub+zip",
    // Une heure dans le cache du navigateur seul : refermer puis rouvrir le livre ne le retélécharge
    // pas ; un droit retiré vaut au plus tard à l'heure suivante, sur l'appareil qui l'avait déjà.
    "Cache-Control": "private, max-age=3600",
    "Content-Disposition": req.nextUrl.searchParams.get("telecharger") === "1" ? attachment(visible) : "inline",
    "X-Content-Type-Options": "nosniff",
  };
  const length = upstream.headers.get("content-length");
  if (length && /^\d+$/.test(length)) headers["Content-Length"] = length;
  return new NextResponse(upstream.body, { status: 200, headers });
}

/**
 * « Titre - Auteur.epub » : le nom encodé (RFC 5987 — l'apostrophe aussi, fréquente dans un titre) pour les accents, une version ASCII pour les
 * navigateurs qui ne lisent que `filename`. Les caractères qu'un système de fichiers refuse sont retirés.
 */
function attachment(book: { name: string; authors: readonly string[] }): string {
  const base = [book.name, book.authors[0]].filter(Boolean).join(" - ").replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 150) || "livre";
  const ascii = base.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^\x20-\x7e]/g, "_");
  return `attachment; filename="${ascii}.epub"; filename*=UTF-8''${encodeURIComponent(`${base}.epub`).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`;
}
