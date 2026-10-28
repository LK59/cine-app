import { NextRequest, NextResponse } from "next/server";
import { config } from "@/lib/config";
import { booksCaller } from "@/lib/books/guard";
import { REQUEST_LIMITS, allRequests, createRequest, notifyNewRequest, requestsOf, requestsToday, validRequestInput } from "@/lib/books/requests";

/**
 * Les demandes de livres (option, DECISIONS.md §127). 404 tant que les livres ou les demandes sont
 * coupés, comme le reste des livres.
 *
 * `GET` : les siennes ; l'administrateur reçoit aussi toutes les autres (`all`).
 * `POST` : une demande pour soi — titre requis, auteur et note facultatifs, bornés ; vingt par jour et
 * par compte. Les administrateurs sont prévenus par la notification des signalements.
 */
export async function GET(req: NextRequest) {
  const caller = await booksCaller(req);
  if (caller instanceof NextResponse) return caller;
  if (config.books?.requests !== true) return new NextResponse(null, { status: 404 });
  return NextResponse.json(
    { mine: requestsOf(caller.u), ...(caller.role === "admin" ? { all: allRequests() } : {}) },
    { headers: { "Cache-Control": "private, no-store" } }
  );
}

export async function POST(req: NextRequest) {
  const caller = await booksCaller(req);
  if (caller instanceof NextResponse) return caller;
  if (config.books?.requests !== true) return new NextResponse(null, { status: 404 });
  const raw = await req.text().catch(() => "");
  if (raw.length > 4000) return new NextResponse(null, { status: 413 });
  let body: unknown = null;
  try {
    body = JSON.parse(raw);
  } catch {
    /* refusé juste après */
  }
  const input = validRequestInput(body);
  if (!input) return NextResponse.json({ error: "Demande invalide", code: "invalid_request" }, { status: 400 });
  if (requestsToday(caller.u) >= REQUEST_LIMITS.perDay) {
    return NextResponse.json({ error: "Trop de demandes aujourd'hui", code: "rate_limited" }, { status: 429 });
  }
  const request = createRequest(caller.u, caller.jfId ?? caller.u, input);
  void notifyNewRequest(request);
  return NextResponse.json({ request }, { status: 201 });
}
