import { NextRequest, NextResponse } from "next/server";
import { sonarr } from "@/lib/clients/sonarr";
import { withErrorHandling } from "@/lib/api-helpers";
import { invalidateLibrary } from "@/lib/server-cache";

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  return withErrorHandling(() => sonarr.getSeriesById(Number(params.id)));
}

export async function PUT(req: NextRequest, { params }: { params: { id: string } }) {
  const payload = await req.json();
  return withErrorHandling(() => sonarr.updateSeries(Number(params.id), payload));
}

export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    await sonarr.deleteSeries(Number(params.id));
    invalidateLibrary();
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "Échec de la suppression" }, { status: 500 });
  }
}
