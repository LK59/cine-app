import { NextResponse } from "next/server";
import { cachedMovies } from "@/lib/server-cache";
import { posterUrl } from "@/lib/images";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const movies = await cachedMovies();
    const sorted = movies
      .filter((m) => m.added && m.added !== "0001-01-01T00:00:00Z")
      .sort((a, b) => new Date(b.added!).getTime() - new Date(a.added!).getTime())
      .slice(0, 8);

    return NextResponse.json(
      sorted.map((m) => ({
        id: m.id,
        title: m.title,
        year: m.year,
        added: m.added,
        hasFile: m.hasFile,
        posterUrl: posterUrl(m.images, "thumb"),
      }))
    );
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 502 });
  }
}
