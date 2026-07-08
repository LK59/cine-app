import { NextRequest, NextResponse } from "next/server";
import { radarr } from "@/lib/clients/radarr";
import { withErrorHandling } from "@/lib/api-helpers";
import { invalidateLibrary } from "@/lib/server-cache";

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  return withErrorHandling(() => radarr.getMovie(Number(params.id)));
}

export async function PUT(req: NextRequest, { params }: { params: { id: string } }) {
  const payload = await req.json();
  return withErrorHandling(() => radarr.updateMovie(Number(params.id), payload));
}

export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    await radarr.deleteMovie(Number(params.id));
    invalidateLibrary();
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "Échec de la suppression" }, { status: 500 });
  }
}
