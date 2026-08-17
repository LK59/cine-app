// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import enDict from "@/locales/en.json";
import { TranslationProvider, useT, useLocale } from "@/components/TranslationProvider";

function Probe() {
  const t = useT();
  const { locale } = useLocale();
  return (
    <div>
      <span data-testid="key">{t("common.cancel")}</span>
      <span data-testid="unknown">{t("does.not.exist")}</span>
      <span data-testid="locale">{locale}</span>
    </div>
  );
}

function SwitcherProbe() {
  const t = useT();
  const { locale, setLocale } = useLocale();
  return (
    <div>
      <span data-testid="key">{t("common.cancel")}</span>
      <span data-testid="locale">{locale}</span>
      <button onClick={() => setLocale("es")}>switch</button>
    </div>
  );
}

// The mount effect fetches instance/user language preferences and reloads the page if the
// resolved cookie is out of sync — mocking both endpoints to resolve as "unset" keeps every test
// on the harmless "no cookie yet, apply the resolved default" branch, since jsdom doesn't
// support window.location.reload().
function mockUnsetPreferences() {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({ ok: false, json: async () => null })
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  document.cookie = "cine-lang=;path=/;max-age=0";
});

describe("TranslationProvider", () => {
  it("renders French by default when no initialLocale/initialDict is provided", async () => {
    mockUnsetPreferences();
    render(
      <TranslationProvider>
        <Probe />
      </TranslationProvider>
    );

    expect(screen.getByTestId("key").textContent).toBe("Annuler");
    expect(screen.getByTestId("locale").textContent).toBe("fr");
  });

  it("renders immediately in the server-resolved locale when initialLocale/initialDict are given", () => {
    mockUnsetPreferences();
    render(
      <TranslationProvider initialLocale="en" initialDict={enDict as Record<string, unknown>}>
        <Probe />
      </TranslationProvider>
    );

    // No waitFor: this is the whole point of the initial* props — correct on first paint,
    // no flash of French before an effect resolves it.
    expect(screen.getByTestId("key").textContent).toBe("Cancel");
    expect(screen.getByTestId("locale").textContent).toBe("en");
  });

  it("falls back to the raw key when a translation is missing in both dict and fallback", () => {
    mockUnsetPreferences();
    render(
      <TranslationProvider>
        <Probe />
      </TranslationProvider>
    );

    expect(screen.getByTestId("unknown").textContent).toBe("does.not.exist");
  });

  it("useT()/useLocale() outside a provider fall back to the French default instead of throwing", () => {
    expect(() => render(<Probe />)).not.toThrow();
    expect(screen.getByTestId("key").textContent).toBe("Annuler");
    expect(screen.getByTestId("locale").textContent).toBe("fr");
  });

  it("setLocale switches the active dict, persists the cookie, and syncs the server preference", async () => {
    mockUnsetPreferences();
    const user = userEvent.setup();
    render(
      <TranslationProvider>
        <SwitcherProbe />
      </TranslationProvider>
    );

    await act(async () => {
      await user.click(screen.getByText("switch"));
    });

    // `t` settles slightly after `locale` (it depends on the async loadLocaleDict() call) — wait
    // on the translated text itself rather than the locale flag, which flips one render earlier.
    await waitFor(() => expect(screen.getByTestId("key").textContent).toBe("Cancelar"));
    expect(screen.getByTestId("locale").textContent).toBe("es");
    expect(document.cookie).toContain("cine-lang=es");
    expect(fetch).toHaveBeenCalledWith(
      "/api/user/preferences",
      expect.objectContaining({ method: "PUT" })
    );
  });
});
