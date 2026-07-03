import { NextResponse } from "next/server";
import { cachedSeries } from "@/lib/server-cache";
import { posterUrl } from "@/lib/images";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const series = await cachedSeries();
    const sorted = series
      .filter((s) => s.added && s.added !== "0001-01-01T00:00:00Z")
      .sort((a, b) => new Date(b.added!).getTime() - new Date(a.added!).getTime())
      .slice(0, 8);

    return NextResponse.json(
      sorted.map((s) => ({
        id: s.id,
        title: s.title,
        year: s.year,
        added: s.added,
        status: s.status,
        posterUrl: posterUrl(s.images, "thumb"),
      }))
    );
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 502 });
  }
}
