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
//
// Rendu à `/gestion` seulement : `/` appartient au cinéma depuis la bascule.
export async function Overview() {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  const session = await verifySessionFull(token);

  // Le proxy renvoie déjà un compte ordinaire au cinéma (`ADMIN_ONLY_PAGES`) ; cette garde-ci
  // empêche seulement que la charge utile de `/api/dashboard` — refusée à ce compte par l'API —
  // reparte un jour dans le HTML si la page sortait de la liste (BUREAU-14, 15/10/2026).
  if (session?.role !== "admin") return <DashboardClient initialData={undefined} />;

  let initialData: DashboardPayload | undefined;
  try {
    initialData = await buildDashboardPayload(session);
  } catch {
    // Fall back to the normal client-side fetch — no worse than before this change.
    initialData = undefined;
  }

  return <DashboardClient initialData={initialData} />;
}
