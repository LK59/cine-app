import { NextRequest } from "next/server";
import { radarr } from "@/lib/clients/radarr";
import { cachedMovies } from "@/lib/server-cache";
import { withErrorHandling } from "@/lib/api-helpers";

export async function GET() {
  return withErrorHandling(() => cachedMovies());
}

export async function POST(req: NextRequest) {
  const payload = await req.json();
  return withErrorHandling(() => radarr.addMovie(payload));
}
