import { NextRequest } from "next/server";
import { bazarr } from "@/lib/clients/bazarr";
import { withErrorHandling } from "@/lib/api-helpers";

export async function GET(req: NextRequest) {
  const movieLength = Number(req.nextUrl.searchParams.get("movieLength")) || 25;
  const episodeLength = Number(req.nextUrl.searchParams.get("episodeLength")) || 25;
  return withErrorHandling(async () => {
    const [movies, episodes] = await Promise.all([
      bazarr.getWantedMovies(movieLength),
      bazarr.getWantedEpisodes(episodeLength),
    ]);
    return { movies, episodes };
  });
}
