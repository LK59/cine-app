import { NextResponse } from "next/server";
import { VIP_PERSONS } from "@/lib/vip-persons";

export async function GET(_req: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const id = Number(params.id);
  const vip = VIP_PERSONS[id];
  if (!vip) return NextResponse.json({ error: "Not found" }, { status: 404 });
  // Return everything including bio — this stays server-side
  return NextResponse.json(vip);
}
