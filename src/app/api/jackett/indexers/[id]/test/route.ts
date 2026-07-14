import { NextRequest, NextResponse } from "next/server";
import { jackett } from "@/lib/clients/jackett";

export async function POST(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const ok = await jackett.testIndexer(params.id);
  return NextResponse.json({ ok });
}
