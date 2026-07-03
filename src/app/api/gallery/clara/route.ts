import { NextResponse } from "next/server";
import fs from "fs";

export const dynamic = "force-dynamic";

export async function GET() {
  const dir = "/app/gallery/clara";
  try {
    const files = fs
      .readdirSync(dir)
      .filter((f) => /\.(jpg|jpeg|png|webp)$/i.test(f))
      .sort();
    return NextResponse.json({ files });
  } catch {
    return NextResponse.json({ files: [] });
  }
}
