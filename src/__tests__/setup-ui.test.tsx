// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { SWRConfig } from "swr";

vi.mock("@/components/TranslationProvider", () => ({
  useT: () => (k: string, v?: Record<string, string>) => (v ? `${k} ${JSON.stringify(v)}` : k),
  useLocale: () => ({ locale: "fr", setLocale: vi.fn() }),
}));

import { SettingsGroupCard } from "@/components/settings/SettingsGroupCard";
import { HelloIntro } from "@/components/setup/HelloIntro";
import SetupPage from "@/app/setup/page";
import type { SettingView } from "@/lib/settings/schema";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});

const view = (key: string, o: Partial<SettingView> = {}): SettingView => ({ key, source: "default", value: "", set: false, hint: null, envPresent: false, ...o });

describe("la carte d'un service (assistant et Connexions)", () => {
  it("ne montre jamais un secret, dit d'où vient une valeur, et propose de revenir au .env", () => {
    const onReset = vi.fn();
    const views = new Map([
      ["RADARR_URL", view("RADARR_URL", { source: "app", value: "http://radarr:7878", envPresent: true })],
      ["RADARR_API_KEY", view("RADARR_API_KEY", { source: "env", value: null, set: true, hint: "…abcd", envPresent: true })],
    ]);
    render(<SettingsGroupCard group="radarr" views={views} draft={{}} onDraft={vi.fn()} onReset={onReset} />);
    const key = screen.getByLabelText("setup.fields.RADARR_API_KEY") as HTMLInputElement;
    expect(key.value).toBe("");
    expect(key.type).toBe("password");
    expect(screen.getByText(/setup.secretSet/)).toBeTruthy();
    expect(screen.getByText("setup.source.env")).toBeTruthy();
    fireEvent.click(screen.getByText("setup.resetEnv"));
    expect(onReset).toHaveBeenCalledWith("RADARR_URL");
  });
});

describe("le premier écran", () => {
  it("fait défiler « Bonjour » et propose les quatre langues", () => {
    const onChoose = vi.fn();
    render(<HelloIntro current="fr" busy={null} onChoose={onChoose} />);
    expect(screen.getByText("Bonjour")).toBeTruthy();
    fireEvent.click(screen.getByText("English"));
    expect(onChoose).toHaveBeenCalledWith("en");
  });
});

describe("l'assistant de premier lancement", () => {
  beforeEach(() => localStorage.setItem("cine:setup-step", "1"));

  it("demande de créer le compte administrateur quand aucun n'existe, et l'envoie", async () => {
    const calls: { url: string; body?: string }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, body: init?.body as string | undefined });
        if (url === "/api/setup/status") return new Response(JSON.stringify({ done: false, needsAdmin: true }), { status: 200 });
        if (url === "/api/setup/admin") return new Response(JSON.stringify({ ok: true }), { status: 200 });
        return new Response("{}", { status: 401 });
      }),
    );
    render(
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
        <SetupPage />
      </SWRConfig>,
    );
    await screen.findByText("setup.admin.create");
    fireEvent.change(screen.getByLabelText("setup.admin.password"), { target: { value: "un-mot-de-passe" } });
    fireEvent.change(screen.getByLabelText("setup.admin.confirm"), { target: { value: "un-mot-de-passe" } });
    fireEvent.click(screen.getByText("setup.admin.create"));
    await waitFor(() => expect(calls.some((c) => c.url === "/api/setup/admin")).toBe(true));
    expect(JSON.parse(calls.find((c) => c.url === "/api/setup/admin")!.body!)).toEqual({ username: "admin", password: "un-mot-de-passe" });
  });

  it("refuse deux mots de passe différents sans rien envoyer", async () => {
    const fetchSpy = vi.fn(async (url: string) =>
      url === "/api/setup/status" ? new Response(JSON.stringify({ done: false, needsAdmin: true }), { status: 200 }) : new Response("{}", { status: 401 }),
    );
    vi.stubGlobal("fetch", fetchSpy);
    render(
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
        <SetupPage />
      </SWRConfig>,
    );
    await screen.findByText("setup.admin.create");
    fireEvent.change(screen.getByLabelText("setup.admin.password"), { target: { value: "un-mot-de-passe" } });
    fireEvent.change(screen.getByLabelText("setup.admin.confirm"), { target: { value: "autre-chose!" } });
    fireEvent.click(screen.getByText("setup.admin.create"));
    expect(await screen.findByText("setup.admin.mismatch")).toBeTruthy();
    expect(fetchSpy.mock.calls.some(([u]) => u === "/api/setup/admin")).toBe(false);
  });
});

describe("le premier écran de l'assistant", () => {
  // Installation neuve essayée le 13/10/2026 : la langue est déjà allumée, et l'écran n'avait aucun
  // bouton pour avancer — il fallait deviner qu'on touche la langue déjà choisie.
  it("offre « Suivant », qui garde la langue en cours et mène au compte administrateur", async () => {
    const calls: { url: string; body?: string }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, body: init?.body as string | undefined });
        if (url === "/api/setup/status") return new Response(JSON.stringify({ done: false, needsAdmin: true }), { status: 200 });
        if (url === "/api/setup/language") return new Response(JSON.stringify({ ok: true }), { status: 200 });
        return new Response("{}", { status: 401 });
      }),
    );
    render(
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
        <SetupPage />
      </SWRConfig>,
    );
    fireEvent.click(await screen.findByText("setup.next"));
    await screen.findByText("setup.admin.create");
    expect(JSON.parse(calls.find((c) => c.url === "/api/setup/language")!.body!)).toEqual({ lang: "fr" });
    expect(localStorage.getItem("cine:setup-step")).toBe("1");
  });
});
