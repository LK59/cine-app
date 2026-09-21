// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { act } from "react";
import { renderToString } from "react-dom/server";
import { hydrateRoot } from "react-dom/client";

vi.mock("@/components/TranslationProvider", () => ({
  useT: () => (key: string, vars?: Record<string, unknown>) => (vars ? `${key}:${vars.n}` : key),
}));

import { RelativeTime } from "@/components/RelativeTime";

/**
 * L'erreur React n°418 de `/gestion` (21/09/2026) : la vue d'ensemble est rendue par le serveur,
 * reprise par le navigateur, et « il y a 3 min » devenait « il y a 4 min » entre les deux.
 */
describe("RelativeTime", () => {
  afterEach(() => vi.useRealTimers());

  it("laisse une minute passer entre le serveur et le navigateur sans erreur d'hydratation", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const added = new Date("2026-09-21T08:00:00Z").toISOString();
    vi.setSystemTime(new Date("2026-09-21T08:03:59Z"));
    const html = renderToString(<RelativeTime date={added} />);
    expect(html).toContain("minutesAgo:3");

    const container = document.createElement("div");
    container.innerHTML = html;
    document.body.appendChild(container);
    vi.setSystemTime(new Date("2026-09-21T08:04:01Z"));

    const recoverable = vi.fn();
    await act(async () => {
      hydrateRoot(container, <RelativeTime date={added} />, { onRecoverableError: recoverable });
    });
    expect(recoverable).not.toHaveBeenCalled();
  });
});
