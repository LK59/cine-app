// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup, act } from "@testing-library/react";

vi.mock("@/components/Toast", () => ({ useToast: () => ({ info: vi.fn(), success: vi.fn(), error: vi.fn() }) }));
vi.mock("@/components/TranslationProvider", () => ({ useT: () => (k: string) => k }));
vi.mock("@/lib/foregroundGate", () => ({ afterForegroundCheck: (f: () => void) => f() }));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

// 18/11/2026 : chaque page de la Gestion demandait l'autorisation des notifications à son ouverture,
// hors de tout geste — refusée avec une erreur par Firefox et Safari, demande non sollicitée dans Chrome.
describe("SSENotifier", () => {
  it("ne demande pas l'autorisation des notifications au montage", async () => {
    const requestPermission = vi.fn(async () => "default");
    vi.stubGlobal("Notification", Object.assign(vi.fn(), { permission: "default", requestPermission }));
    vi.stubGlobal("EventSource", class { addEventListener() {} close() {} set onerror(_: unknown) {} set onopen(_: unknown) {} });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ results: [] }))));
    const { SSENotifier } = await import("@/components/SSENotifier");
    await act(async () => {
      render(<SSENotifier />);
    });
    expect(requestPermission).not.toHaveBeenCalled();
  });
});
