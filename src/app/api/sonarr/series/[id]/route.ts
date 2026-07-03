import { NextRequest } from "next/server";
import { sonarr } from "@/lib/clients/sonarr";
import { withErrorHandling } from "@/lib/api-helpers";

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  return withErrorHandling(() => sonarr.getSeriesById(Number(params.id)));
}

export async function PUT(req: NextRequest, { params }: { params: { id: string } }) {
  const payload = await req.json();
  return withErrorHandling(() => sonarr.updateSeries(Number(params.id), payload));
}

export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  return withErrorHandling(() => sonarr.deleteSeries(Number(params.id)));
}
