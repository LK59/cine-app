import { NextRequest, NextResponse } from "next/server";
import { bookIdOf, booksCaller } from "@/lib/books/guard";
import { bookIndex } from "@/lib/books/bookIndex";
import { epubCover, googleCover } from "@/lib/books/covers";
import { enrichOf } from "@/lib/books/googleBooks";
import { config } from "@/lib/config";
import { lengthHeader } from "@/lib/responseFraming";

/**
 * La couverture d'un livre tirée de son EPUB (option, DECISIONS.md §127), quand Jellyfin n'en a pas —
 * faite à la première demande, gardée sur le disque (`covers.ts`). Le livre doit être dans l'index de ce
 * compte : un livre hors de ses droits, ou porteur d'un de ses tags bloqués, n'a pas de couverture ici
 * non plus. `v` : l'empreinte du fichier ; avec elle, l'image se garde un an.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const caller = await booksCaller(req);
  if (caller instanceof NextResponse) return caller;
  const id = bookIdOf((await params).id);
  if (!id) return new NextResponse(null, { status: 400 });
  let fileTag: string | null;
  try {
    // Une copie cachée (doublon d'un même livre) a aussi sa couverture : elle reste lisible.
    const book = (await bookIndex(caller)).all.get(id);
    // Absent de l'index de ce compte : 204, comme un livre sans couverture, jamais 404 (règle CrowdSec,
    // plus bas). Le cas arrive sans rien d'anormal : un EPUB reconnu illisible pendant que la page
    // montre encore sa carte sort de l'index, et sa couverture répondait 404 (vu le 18/11/2026 sur
    // « Dome »). Un livre interdit au compte ne se distingue pas non plus d'un livre sans image.
    if (!book) return new NextResponse(null, { status: 204, headers: { "Cache-Control": "private, no-store" } });
    fileTag = book.fileTag;
  } catch {
    return new NextResponse(null, { status: 502 });
  }
  let image = fileTag ? await epubCover(id, fileTag) : null;
  // Ni Jellyfin ni l'EPUB : celle de Google Books, quand l'option est allumée et qu'elle en a trouvé une.
  if (!image && config.books.googleEnrich) {
    const found = enrichOf(id);
    if (found?.status === "filled" && found.coverUrl) image = await googleCover(id, found.coverUrl);
  }
  // Pas de couverture n'est pas une erreur : 204, pas 404 (29/10/2026). Une grille de livres sans image en
  // demandait une rafale, et CrowdSec, devant le proxy, y a lu un robot qui fouille le site (« http-probing » :
  // douze 404 en onze secondes) — un compte a été coupé de l'application quatre heures. La couverture dessinée
  // prend la place, comme avant ; la réponse se garde une heure.
  if (!image) return new NextResponse(null, { status: 204, headers: { "Cache-Control": "private, max-age=3600" } });
  const pinned = req.nextUrl.searchParams.get("v") === fileTag;
  return new NextResponse(new Uint8Array(image), {
    headers: {
      "Content-Type": "image/webp",
      ...lengthHeader(image.byteLength),
      "Cache-Control": pinned ? "private, max-age=31536000, immutable" : "private, max-age=3600",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
