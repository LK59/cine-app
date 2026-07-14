import { NextRequest, NextResponse } from "next/server";
import { radarr } from "@/lib/clients/radarr";
import { withErrorHandling } from "@/lib/api-helpers";
import { invalidateLibrary } from "@/lib/server-cache";

export async function GET(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  return withErrorHandling(() => radarr.getMovie(Number(params.id)));
}

export async function PUT(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const payload = await req.json();
  return withErrorHandling(() => radarr.updateMovie(Number(params.id), payload));
}

export async function DELETE(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    await radarr.deleteMovie(Number(params.id));
    invalidateLibrary();
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "Échec de la suppression" }, { status: 500 });
  }
}
