// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, act } from "@testing-library/react";
import { reportClientError, forgetReportedClientErrors } from "@/lib/reportClientError";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { ClientErrorListener } from "@/components/ClientErrorListener";

// Une erreur du navigateur n'allait nulle part : ni les écrans d'erreur, ni la barrière qui
// entoure le lecteur à la racine — qui faisait disparaître le film sans un mot — n'en laissaient
// de trace ailleurs que dans une console qu'on n'ouvre pas sur un téléphone.

let fetchMock: ReturnType<typeof vi.fn>;
const sent = () => fetchMock.mock.calls.map(([, init]) => JSON.parse((init as RequestInit).body as string) as Record<string, string>);

beforeEach(() => {
  forgetReportedClientErrors();
  fetchMock = vi.fn(async () => ({ ok: true }));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("reportClientError", () => {
  it("envoie le message, la pile, l'origine et l'endroit, en `keepalive`", () => {
    window.location.hash = "#film=12";
    const error = new TypeError("x is undefined");
    reportClientError(error, "window");

    expect(fetchMock).toHaveBeenCalledWith("/api/client-error", expect.objectContaining({ method: "POST", keepalive: true }));
    expect(sent()[0]).toMatchObject({ source: "window", name: "TypeError", message: "x is undefined", url: "/#film=12" });
    expect(sent()[0].stack).toContain("x is undefined");
  });

  it("n'envoie qu'une fois la même erreur, et au plus vingt par page", () => {
    for (let i = 0; i < 5; i += 1) reportClientError(new Error("en boucle"), "window");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    for (let i = 0; i < 50; i += 1) reportClientError(new Error(`erreur ${i}`), "window");
    expect(fetchMock).toHaveBeenCalledTimes(20);
  });

  it("se tait sur le bruit : requêtes annulées, ResizeObserver, scripts tiers, extensions", () => {
    reportClientError(new DOMException("aborted", "AbortError"), "rejection");
    reportClientError(new Error("ResizeObserver loop completed with undelivered notifications."), "window");
    reportClientError("Script error.", "window");
    const fromExtension = new Error("boom");
    fromExtension.stack = "Error: boom\n    at chrome-extension://abc/content.js:1:1";
    reportClientError(fromExtension, "window");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("décrit aussi ce qui n'est pas une Error", () => {
    reportClientError({ code: 42 }, "rejection");
    reportClientError(undefined, "rejection");
    expect(sent().map((body) => body.message)).toEqual(['{"code":42}', "undefined"]);
  });

  it("ne lève jamais, même quand l'envoi lui-même lève", () => {
    vi.stubGlobal("fetch", () => {
      throw new Error("pas de réseau");
    });
    expect(() => reportClientError(new Error("x"), "window")).not.toThrow();
  });
});

describe("ErrorBoundary", () => {
  function Bomb(): never {
    throw new Error("rendu cassé");
  }

  it("dit ce qu'elle a attrapé, sous son nom, au lieu de faire disparaître son contenu en silence", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    render(
      <ErrorBoundary name="lecteur">
        <Bomb />
      </ErrorBoundary>
    );
    expect(sent()).toHaveLength(1);
    expect(sent()[0]).toMatchObject({ source: "component:lecteur", message: "rendu cassé" });
    expect(sent()[0].componentStack).toContain("Bomb");
  });
});

describe("ClientErrorListener", () => {
  it("rapporte ce qu'aucune barrière ne voit : erreurs hors rendu et promesses rejetées", () => {
    render(<ClientErrorListener />);

    act(() => void window.dispatchEvent(new ErrorEvent("error", { error: new Error("dans un rappel"), message: "dans un rappel" })));
    const rejection = new Event("unhandledrejection") as Event & { reason?: unknown };
    rejection.reason = new Error("promesse oubliée");
    act(() => void window.dispatchEvent(rejection));

    expect(sent().map((body) => [body.source, body.message])).toEqual([
      ["window", "dans un rappel"],
      ["rejection", "promesse oubliée"],
    ]);
  });

  it("n'écoute plus une fois démonté", () => {
    const { unmount } = render(<ClientErrorListener />);
    unmount();
    // Un message seul : jsdom relance une `ErrorEvent` porteuse d'une Error que plus personne
    // n'écoute, et c'est le test qui tomberait, pas le composant.
    act(() => void window.dispatchEvent(new ErrorEvent("error", { message: "après" })));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
