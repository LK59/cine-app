import { NextRequest, NextResponse } from "next/server";
import { radarr } from "@/lib/clients/radarr";
import { invalidateLibrary } from "@/lib/server-cache";

export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  const movie = await radarr.getMovie(Number(params.id));
  if (!movie.movieFile?.id) {
    return NextResponse.json({ error: "Aucun fichier associé" }, { status: 404 });
  }
  await radarr.deleteMovieFile(movie.movieFile.id);
  invalidateLibrary();
  return NextResponse.json({ ok: true });
}
