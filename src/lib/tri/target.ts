import type { TriKind } from "./types";

/** `{ kind, id }` d'un corps de requête, ou `null`. */
export function parseTarget(body: unknown): { kind: TriKind; id: number } | null {
  if (!body || typeof body !== "object") return null;
  const { kind, id } = body as { kind?: unknown; id?: unknown };
  if ((kind !== "movie" && kind !== "series") || typeof id !== "number" || !Number.isInteger(id) || id <= 0) return null;
  return { kind, id };
}
