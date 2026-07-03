import { NextRequest } from "next/server";
import { radarr } from "@/lib/clients/radarr";
import { withErrorHandling } from "@/lib/api-helpers";

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  return withErrorHandling(() => radarr.getMovie(Number(params.id)));
}

export async function PUT(req: NextRequest, { params }: { params: { id: string } }) {
  const payload = await req.json();
  return withErrorHandling(() => radarr.updateMovie(Number(params.id), payload));
}

export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  return withErrorHandling(() => radarr.deleteMovie(Number(params.id)));
}
