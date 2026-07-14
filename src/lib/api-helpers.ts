import { NextResponse } from "next/server";
import { HttpError } from "@/lib/http";
import { logError } from "@/lib/logger";

export async function withErrorHandling<T>(fn: () => Promise<T>, scope = "api"): Promise<NextResponse> {
  try {
    const data = await fn();
    return NextResponse.json(data);
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 502;
    const message = err instanceof Error ? err.message : "Unknown error";
    logError(scope, err, { status });
    return NextResponse.json({ error: message }, { status });
  }
}
