import { NextRequest, NextResponse } from "next/server";
import { getTmdbLocale } from "@/lib/i18n";
import { heroInfo, type HeroMediaType } from "@/lib/heroInfo";

/** Le synopsis et la distribution de la bannière du bureau — voir `heroInfo`. */
export async function GET(req: NextRequest, props: { params: Promise<{ type: string; tmdbId: string }> }) {
  const { type, tmdbId } = await props.params;
  const id = Number(tmdbId);
  if ((type !== "movie" && type !== "series") || !Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ error: "Titre inconnu" }, { status: 400 });
  }
  const info = await heroInfo(type as HeroMediaType, id, getTmdbLocale(req.cookies.get("cine-lang")?.value));
  return NextResponse.json(info);
}
