// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { SWRConfig } from "swr";

vi.mock("@/components/TranslationProvider", () => ({
  useT: () => (k: string, v?: Record<string, string>) => (v ? `${k} ${JSON.stringify(v)}` : k),
  useLocale: () => ({ locale: "fr", setLocale: vi.fn() }),
}));

import { DeploymentGuide, SettingsGroupCard, testFailureText } from "@/components/settings/SettingsGroupCard";
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
    // Le code d'installation, avec où le trouver (20/10/2026).
    expect(screen.getByText("setup.admin.codeHint")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("setup.admin.code"), { target: { value: " ABCD-EFGH-JKLM " } });
    fireEvent.change(screen.getByLabelText("setup.admin.password"), { target: { value: "un-mot-de-passe" } });
    fireEvent.change(screen.getByLabelText("setup.admin.confirm"), { target: { value: "un-mot-de-passe" } });
    fireEvent.click(screen.getByText("setup.admin.create"));
    await waitFor(() => expect(calls.some((c) => c.url === "/api/setup/admin")).toBe(true));
    expect(JSON.parse(calls.find((c) => c.url === "/api/setup/admin")!.body!)).toEqual({ setupCode: "ABCD-EFGH-JKLM", username: "admin", password: "un-mot-de-passe" });
  });

  it("dit où trouver le code quand il est refusé", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url === "/api/setup/status") return new Response(JSON.stringify({ done: false, needsAdmin: true }), { status: 200 });
        if (url === "/api/setup/admin") return new Response(JSON.stringify({ error: "invalid-setup-code" }), { status: 403 });
        return new Response("{}", { status: 401 });
      }),
    );
    render(
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
        <SetupPage />
      </SWRConfig>,
    );
    await screen.findByText("setup.admin.create");
    fireEvent.change(screen.getByLabelText("setup.admin.code"), { target: { value: "mauvais" } });
    fireEvent.change(screen.getByLabelText("setup.admin.password"), { target: { value: "un-mot-de-passe" } });
    fireEvent.change(screen.getByLabelText("setup.admin.confirm"), { target: { value: "un-mot-de-passe" } });
    fireEvent.click(screen.getByText("setup.admin.create"));
    expect(await screen.findByText("setup.admin.badCode")).toBeTruthy();
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

/**
 * L'essai d'une installation neuve du 13/10/2026 : « Suivant » n'essayait jamais la clé, et
 * l'assistant se terminait avec des clés refusées. Il teste maintenant chaque service renseigné
 * de l'étape ; un échec dit pourquoi et propose de continuer quand même.
 */
describe("« Suivant » sur une étape de service", () => {
  const settings = [
    view("JELLYFIN_URL", { source: "app", value: "http://jellyfin:8096" }),
    view("JELLYFIN_API_KEY", { source: "app", set: true, hint: "…abcd" }),
    view("PLAYER_SERVER_FALLBACK", { value: "true" }),
  ];
  function stub(test: { ok: boolean; detail: string }) {
    const calls: { url: string; body?: string }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, body: init?.body as string | undefined });
        if (url === "/api/setup/status") return new Response(JSON.stringify({ done: false, needsAdmin: false }), { status: 200 });
        if (url === "/api/settings") return new Response(JSON.stringify({ settings, missing: [], setupDone: false }), { status: 200 });
        if (url === "/api/settings/test") return new Response(JSON.stringify(test), { status: 200 });
        return new Response("{}", { status: 404 });
      }),
    );
    return calls;
  }
  function renderAt(step: number) {
    localStorage.setItem("cine:setup-step", String(step));
    render(
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
        <SetupPage />
      </SWRConfig>,
    );
  }

  it("teste la connexion, dit pourquoi elle échoue et propose de continuer quand même", async () => {
    const calls = stub({ ok: false, detail: "unauthorized" });
    renderAt(2);
    await screen.findByLabelText("setup.fields.JELLYFIN_URL");
    fireEvent.click(screen.getByText("setup.next"));
    expect(await screen.findByText(/setup\.testFail\.unauthorized/)).toBeTruthy();
    expect(JSON.parse(calls.find((c) => c.url === "/api/settings/test")!.body!)).toMatchObject({ group: "jellyfin" });
    // Pas de blocage dur : l'étape reste, avec le moyen d'avancer.
    expect(localStorage.getItem("cine:setup-step")).toBe("2");
    fireEvent.click(screen.getByText("setup.continueAnyway"));
    await waitFor(() => expect(localStorage.getItem("cine:setup-step")).toBe("3"));
  });

  it("avance sans rien demander quand la connexion réussit", async () => {
    stub({ ok: true, detail: "Jellyfin 12" });
    renderAt(2);
    await screen.findByLabelText("setup.fields.JELLYFIN_URL");
    fireEvent.click(screen.getByText("setup.next"));
    await waitFor(() => expect(localStorage.getItem("cine:setup-step")).toBe("3"));
    expect(screen.queryByText("setup.continueAnyway")).toBeNull();
  });

  // Un complément laissé vide n'est pas branché : il n'y a rien à tester.
  it("ne teste pas les compléments laissés vides, et dit ce qui se règle ensuite", async () => {
    const calls = stub({ ok: false, detail: "unreachable" });
    renderAt(5);
    await screen.findByText("setup.later");
    // La carte de la langue renvoie à Compte → Langue, pas au texte du groupe (Compte → Interface).
    expect(screen.getByText("setup.groups.defaults.whyLanguage")).toBeTruthy();
    expect(screen.queryByText("setup.groups.defaults.why")).toBeNull();
    fireEvent.click(screen.getByText("setup.next"));
    await waitFor(() => expect(localStorage.getItem("cine:setup-step")).toBe("6"));
    expect(calls.some((c) => c.url === "/api/settings/test")).toBe(false);
  });
});

describe("le message d'un test raté", () => {
  // Une adresse sans http:// : « Adresse invalide », comme à l'enregistrement — pas « Injoignable ».
  it("dit « adresse invalide » comme l'enregistrement", () => {
    const t = (k: string) => k;
    expect(testFailureText(t, "invalid-url")).toBe("setup.errors.invalid-url");
    expect(testFailureText(t, "unreachable")).toBe("setup.testFail.unreachable");
  });
});

describe("la page Déploiement", () => {
  it("dit si le relais de confiance et le cookie sécurisé sont posés", () => {
    const views = new Map([
      ["TRUSTED_PROXIES", view("TRUSTED_PROXIES", { source: "env", value: "proxy-container", envPresent: true })],
      ["COOKIE_SECURE", view("COOKIE_SECURE", { source: "default", value: "false" })],
    ]);
    render(<DeploymentGuide views={views} />);
    expect(screen.getByTestId("deploy-status-TRUSTED_PROXIES").textContent).toContain("proxy-container");
    expect(screen.getByTestId("deploy-status-TRUSTED_PROXIES").textContent).toContain("setup.deployStatus.set");
    expect(screen.getByTestId("deploy-status-COOKIE_SECURE").textContent).toBe("setup.deployStatus.unset");
  });
});
