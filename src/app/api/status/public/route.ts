import { NextResponse } from "next/server";
import { runAllServiceChecks, computeCapabilities } from "@/lib/healthChecks";
import { statusHistoryDb } from "@/lib/db";
import { analyzeHistory } from "@/lib/statusHistory";
import { POLL_INTERVAL_MS } from "@/lib/statusCron";

export const dynamic = "force-dynamic";

const SEVEN_DAYS_MS = 7 * 24 * 3600_000;

// Public — no session required (see PUBLIC_PATHS in proxy.ts). Deliberately returns only
// capability ids/statuses, never a raw hostname, port, API error message or version string —
// unlike /api/health (admin-only, behind the normal session gate — it returns internal service
// URLs, versions, and filesystem paths for troubleshooting from inside the app), this one is
// meant to be safe to expose to the open internet.
export async function GET() {
  const services = await runAllServiceChecks();
  const capabilities = computeCapabilities(services);

  const since = Date.now() - SEVEN_DAYS_MS;
  const payload = capabilities.map((cap) => {
    const history = statusHistoryDb.getCapabilityHistory(cap.id, since);
    const { uptimePct, incidents } = analyzeHistory(history, POLL_INTERVAL_MS);
    return {
      id: cap.id,
      status: cap.status,
      note: cap.note,
      dependsOn: cap.dependsOn,
      softDependsOn: cap.softDependsOn,
      uptime7d: uptimePct,
      incidents7d: incidents.slice(0, 10),
    };
  });

  const overall = payload.every((c) => c.status === "ok")
    ? "ok"
    : payload.some((c) => c.status === "down")
      ? "down"
      : "degraded";

  return NextResponse.json({
    overall,
    checkedAt: new Date().toISOString(),
    capabilities: payload,
  });
}
