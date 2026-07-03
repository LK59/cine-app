import { NextResponse } from "next/server";
import { VIP_PERSONS } from "@/lib/vip-persons";

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const id = Number(params.id);
  const vip = VIP_PERSONS[id];
  if (!vip) return NextResponse.json({ error: "Not found" }, { status: 404 });
  // Return everything including bio — this stays server-side
  return NextResponse.json(vip);
}
