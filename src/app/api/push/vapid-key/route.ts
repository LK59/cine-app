import { NextResponse } from "next/server";

export async function GET() {
  const key = process.env.VAPID_PUBLIC_KEY;
  if (!key) return NextResponse.json({ error: "VAPID non configuré" }, { status: 503 });
  return NextResponse.json({ publicKey: key });
}
