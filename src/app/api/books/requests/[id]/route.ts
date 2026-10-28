import { NextRequest, NextResponse } from "next/server";
import { config } from "@/lib/config";
import { booksCaller } from "@/lib/books/guard";
import { REQUEST_LIMITS, answerRequest, notifyRequester, type BookRequestStatus } from "@/lib/books/requests";

/**
 * L'administrateur répond à une demande de livre (option, DECISIONS.md §127) : « ajouté » ou
 * « refusé », avec un mot facultatif ; qui a demandé en est prévenu. Réservé à l'administrateur — ici,
 * et au proxy, qui refuse toute autre écriture que `POST /api/books/requests` à un compte ordinaire.
 */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const caller = await booksCaller(req);
  if (caller instanceof NextResponse) return caller;
  if (config.books?.requests !== true) return new NextResponse(null, { status: 404 });
  if (caller.role !== "admin") return NextResponse.json({ error: "Action réservée à l'administrateur" }, { status: 403 });
  const id = Number((await params).id);
  if (!Number.isInteger(id) || id <= 0) return new NextResponse(null, { status: 400 });
  const body = (await req.json().catch(() => null)) as { status?: unknown; reply?: unknown } | null;
  const status = body?.status;
  const reply = typeof body?.reply === "string" ? body.reply.trim() : "";
  if ((status !== "added" && status !== "refused" && status !== "pending") || reply.length > REQUEST_LIMITS.reply) {
    return NextResponse.json({ error: "Réponse invalide", code: "invalid_request" }, { status: 400 });
  }
  const updated = answerRequest(id, status as BookRequestStatus, reply);
  if (!updated) return new NextResponse(null, { status: 404 });
  if (updated.status !== "pending") void notifyRequester(updated);
  // Le compte Jellyfin de la personne ne repart pas vers le navigateur.
  return NextResponse.json({ request: { ...updated, userId: undefined } });
}
