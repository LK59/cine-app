// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, act, waitFor } from "@testing-library/react";
import { useWakeLock } from "@/lib/useWakeLock";

function Probe({ active }: { active: boolean }) {
  useWakeLock(active);
  return null;
}

function makeSentinel() {
  const listeners: (() => void)[] = [];
  return {
    released: false,
    release: vi.fn(async function (this: { released: boolean }) {
      this.released = true;
    }),
    addEventListener: (_: "release", fn: () => void) => listeners.push(fn),
    fire: () => listeners.forEach((fn) => fn()),
  };
}

let visibility: DocumentVisibilityState = "visible";

beforeEach(() => {
  visibility = "visible";
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
});

afterEach(() => {
  // @ts-expect-error — nettoyage du bouchon posé sur le navigateur du test.
  delete (navigator as Navigator & { wakeLock?: unknown }).wakeLock;
  vi.restoreAllMocks();
});

function stub(request: () => Promise<unknown>) {
  Object.defineProperty(navigator, "wakeLock", { configurable: true, value: { request } });
}

describe("useWakeLock", () => {
  it("ne demande rien quand rien ne joue", () => {
    const request = vi.fn(async () => makeSentinel());
    stub(request);
    render(<Probe active={false} />);
    expect(request).not.toHaveBeenCalled();
  });

  it("demande le verrou dès qu'un film joue, et le rend à la fermeture", async () => {
    const sentinel = makeSentinel();
    stub(vi.fn(async () => sentinel));
    const view = render(<Probe active />);
    await waitFor(() => expect(sentinel.release).not.toHaveBeenCalled());
    await act(async () => {});
    view.unmount();
    await waitFor(() => expect(sentinel.release).toHaveBeenCalled());
  });

  it("survit à un navigateur qui n'a pas l'API", () => {
    expect(() => render(<Probe active />)).not.toThrow();
  });

  it("survit à un refus", async () => {
    stub(vi.fn(async () => { throw new Error("NotAllowedError"); }));
    const view = render(<Probe active />);
    await act(async () => {});
    expect(() => view.unmount()).not.toThrow();
  });

  it("ne demande rien page cachée, puis reprend au retour", async () => {
    visibility = "hidden";
    const request = vi.fn(async () => makeSentinel());
    stub(request);
    render(<Probe active />);
    await act(async () => {});
    expect(request).not.toHaveBeenCalled();

    visibility = "visible";
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
  });

  it("reprend le verrou que la plateforme a relâché pendant la veille", async () => {
    const first = makeSentinel();
    const second = makeSentinel();
    const request = vi.fn(async () => (request.mock.calls.length === 1 ? first : second));
    stub(request);
    render(<Probe active />);
    await waitFor(() => expect(request).toHaveBeenCalledTimes(1));

    // Ce que fait la plateforme quand la page passe en arrière-plan : elle relâche, sans rendre.
    act(() => first.fire());
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await waitFor(() => expect(request).toHaveBeenCalledTimes(2));
  });
});
