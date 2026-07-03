import { NextResponse } from "next/server";
import { HttpError } from "@/lib/http";

export async function withErrorHandling<T>(fn: () => Promise<T>): Promise<NextResponse> {
  try {
    const data = await fn();
    return NextResponse.json(data);
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 502;
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status });
  }
}
