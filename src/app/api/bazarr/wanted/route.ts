import { bazarr } from "@/lib/clients/bazarr";
import { withErrorHandling } from "@/lib/api-helpers";

export async function GET() {
  return withErrorHandling(async () => {
    const [movies, episodes] = await Promise.all([
      bazarr.getWantedMovies(),
      bazarr.getWantedEpisodes(),
    ]);
    return { movies, episodes };
  });
}
