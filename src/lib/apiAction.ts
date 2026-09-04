/**
 * A mutating call whose failure reaches the screen.
 *
 * Every action in this app was written the same way — `await fetch(...)` and then straight on to
 * refreshing the list — so a request that came back 404 or 502 looked exactly like one that
 * worked: nothing moved, nothing was said. That is how the pause button in Downloads went on
 * being dead through a qBittorrent upgrade without anybody being able to tell why.
 *
 * Throws with whatever the server explained, so the caller only has to say it.
 */
export async function apiAction(url: string, init?: RequestInit): Promise<unknown> {
  const res = await fetch(url, {
    ...init,
    headers: init?.body ? { "Content-Type": "application/json", ...init?.headers } : init?.headers,
  });

  if (!res.ok) {
    // The app's own routes answer `{ error }`; anything else is quoted as it came.
    const said = await res
      .json()
      .then((body: { error?: string }) => body?.error)
      .catch(() => null);
    throw new Error(said || `${res.status} ${res.statusText}`);
  }

  return res.json().catch(() => null);
}
