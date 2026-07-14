// Minimal structured logging — no external dependency, still readable via
// `docker logs`, but each line is a single JSON object so it can be grepped
// or parsed (e.g. `docker logs cine-app | jq 'select(.scope=="qbittorrent")'`).
export function logError(scope: string, err: unknown, context?: Record<string, unknown>): void {
  const message = err instanceof Error ? err.message : String(err);
  console.error(JSON.stringify({
    timestamp: new Date().toISOString(),
    level: "error",
    scope,
    message,
    ...context,
  }));
}
