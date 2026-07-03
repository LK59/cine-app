import { NextRequest, NextResponse } from "next/server";
import { jackett } from "@/lib/clients/jackett";

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const ok = await jackett.testIndexer(params.id);
  return NextResponse.json({ ok });
}
