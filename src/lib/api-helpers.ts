import { NextRequest, NextResponse } from "next/server";
import { HttpError, UpstreamUnreachableError, UPSTREAM_UNREACHABLE } from "@/lib/http";
import { logError } from "@/lib/logger";

// A reverse proxy (Nginx, Traefik, Caddy — the deployment this app assumes, see README) APPENDS
// its own address to X-Forwarded-For rather than replacing it, so the header can arrive as
// "<whatever the client sent>, <proxy's address>". Reading the first entry (as this code used to)
// trusts a value the client fully controls, making IP-keyed rate limiting (login brute-force,
// MDBList quota) trivially bypassable by sending a random value per request. The last entry is
// the one appended by the proxy actually connecting to us, which is the one worth trusting for a
// single-hop deployment.
export function getClientIp(req: NextRequest): string {
  const header = req.headers.get("x-forwarded-for");
  if (!header) return "unknown";
  const parts = header.split(",").map((p) => p.trim()).filter(Boolean);
  return parts.at(-1) ?? "unknown";
}

export async function withErrorHandling<T>(fn: () => Promise<T>, scope = "api"): Promise<NextResponse> {
  try {
    const data = await fn();
    return NextResponse.json(data);
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 502;
    const message = err instanceof Error ? err.message : "Unknown error";
    logError(scope, err, { status });
    /**
     * Un code à côté du message quand l'amont est injoignable.
     *
     * Le statut reste 502 — il dit déjà « la faute est en amont » — mais il ne distingue pas un
     * service absent d'un service qui a répondu de travers. Le code, lui, se compare : c'est ce
     * qui permet à l'écran de dire « la bibliothèque ne répond pas » plutôt que de réciter le
     * message d'une couche réseau. Même motif que `jellyfin_reauth_required`.
     */
    if (err instanceof UpstreamUnreachableError) {
      return NextResponse.json({ error: message, code: UPSTREAM_UNREACHABLE }, { status });
    }
    return NextResponse.json({ error: message }, { status });
  }
}
