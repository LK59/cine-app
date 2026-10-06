// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, act } from "@testing-library/react";
import { SWRConfig } from "swr";
import { guidedScrollClass, setGuidedScroll, useGuidedScroll } from "@/lib/guidedScroll";

function Probe() {
  return <p>{useGuidedScroll() ? "calé" : "libre"}</p>;
}
function withCache(cache: Map<string, unknown>) {
  return function Wrapped(ui: React.ReactNode) {
    return <SWRConfig value={{ provider: () => cache as never, dedupingInterval: 0 }}>{ui}</SWRConfig>;
  };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("le défilement guidé (§50)", () => {
  it("écrit le calage seulement quand il est activé", () => {
    expect(guidedScrollClass(true)).toBe("snap-y snap-mandatory");
    expect(guidedScrollClass(false)).toBe("");
  });

  it("activé par défaut, et la dernière valeur de l'appareil tant que le compte n'a pas répondu", () => {
    render(withCache(new Map())(<Probe />));
    expect(screen.getByText("calé")).toBeTruthy();
    cleanup();
    localStorage.setItem("cine:guided-scroll", "off");
    render(withCache(new Map())(<Probe />));
    expect(screen.getByText("libre")).toBeTruthy();
  });

  it("la valeur du compte l'emporte, et la couper l'envoie au serveur", async () => {
    const fetchSpy = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);
    render(<Probe />);
    expect(screen.getByText("calé")).toBeTruthy();
    await act(async () => {
      await setGuidedScroll(false);
    });
    expect(screen.getByText("libre")).toBeTruthy();
    expect(fetchSpy).toHaveBeenCalledWith("/api/user/preferences", expect.objectContaining({ method: "PUT", body: JSON.stringify({ guidedScroll: false }) }));
    expect(localStorage.getItem("cine:guided-scroll")).toBe("off");
  });
});
