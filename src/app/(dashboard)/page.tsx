import { cookies } from "next/headers";
import { SESSION_COOKIE } from "@/lib/auth";
import { verifySessionFull } from "@/lib/session";
import { buildDashboardPayload, type DashboardPayload } from "@/app/api/dashboard/route";
import { DashboardClient } from "./DashboardClient";

// Server-rendered shell: resolves the same payload the client would otherwise
// fetch on mount, so the first paint shows real data instead of a skeleton.
// This reads through the same in-memory caches as GET /api/dashboard (see
// buildDashboardPayload), so it's normally a cache hit, not extra load on the
// underlying services. Client-side polling (refreshInterval) is untouched —
// this only seeds SWR's initial value via `fallbackData`.
export default async function DashboardPage() {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  const session = await verifySessionFull(token);

  let initialData: DashboardPayload | undefined;
  try {
    initialData = await buildDashboardPayload(session);
  } catch {
    // Fall back to the normal client-side fetch — no worse than before this change.
    initialData = undefined;
  }

  return <DashboardClient initialData={initialData} />;
}
