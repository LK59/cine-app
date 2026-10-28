import { NextRequest, NextResponse } from "next/server";
import { bookIdOf, booksCaller } from "@/lib/books/guard";
import { bookIndex } from "@/lib/books/bookIndex";
import { epubCover } from "@/lib/books/covers";

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
    const book = (await bookIndex(caller)).byId.get(id);
    if (!book) return new NextResponse(null, { status: 404 });
    fileTag = book.fileTag;
  } catch {
    return new NextResponse(null, { status: 502 });
  }
  const image = fileTag ? await epubCover(id, fileTag) : null;
  if (!image) return new NextResponse(null, { status: 404, headers: { "Cache-Control": "private, max-age=3600" } });
  const pinned = req.nextUrl.searchParams.get("v") === fileTag;
  return new NextResponse(new Uint8Array(image), {
    headers: {
      "Content-Type": "image/webp",
      "Content-Length": String(image.byteLength),
      "Cache-Control": pinned ? "private, max-age=31536000, immutable" : "private, max-age=3600",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
