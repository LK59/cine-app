import { NextRequest, NextResponse } from "next/server";
import { jellyseerr } from "@/lib/clients/jellyseerr";
import { withErrorHandling } from "@/lib/api-helpers";

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const { action } = await req.json();
  const id = Number(params.id);
  if (action === "approve") return withErrorHandling(() => jellyseerr.approveRequest(id));
  if (action === "decline") return withErrorHandling(() => jellyseerr.declineRequest(id));
  return NextResponse.json({ error: "Action inconnue" }, { status: 400 });
}
