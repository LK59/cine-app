import { NextRequest, NextResponse } from "next/server";
import { qbittorrent } from "@/lib/clients/qbittorrent";
import { withErrorHandling } from "@/lib/api-helpers";

export async function POST(req: NextRequest, props: { params: Promise<{ hash: string }> }) {
  const params = await props.params;
  const { action } = await req.json();
  if (action === "pause") return withErrorHandling(() => qbittorrent.pause([params.hash]));
  if (action === "resume") return withErrorHandling(() => qbittorrent.resume([params.hash]));
  return NextResponse.json({ error: "Action inconnue" }, { status: 400 });
}

export async function DELETE(req: NextRequest, props: { params: Promise<{ hash: string }> }) {
  const params = await props.params;
  const deleteFiles = req.nextUrl.searchParams.get("deleteFiles") === "true";
  return withErrorHandling(() => qbittorrent.remove([params.hash], deleteFiles));
}
