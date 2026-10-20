// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";

/**
 * Les deux pages d'un lien de partage (DECISIONS.md §112) : `/partage/<code>` décide, côté serveur,
 * entre la fiche (la session de **ce** lien) et le mot de passe (tout le reste, sans rien dire du
 * titre) ; le formulaire échange code et mot de passe contre la session, et prévient un compte du
 * foyer qu'il va être déconnecté de cet appareil.
 */

const cookieValue = vi.hoisted(() => ({ token: "t" as string | undefined }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => (cookieValue.token ? { value: cookieValue.token } : undefined) }) }));
vi.mock("@/lib/auth", () => ({ SESSION_COOKIE: "cine_session" }));
const mockVerify = vi.fn();
vi.mock("@/lib/session", () => ({ verifySessionFull: (...a: unknown[]) => mockVerify(...a) }));
const shares = vi.hoisted(() => ({ byId: {} as Record<string, { code: string }> }));
vi.mock("@/lib/share/store", () => ({
  sharesDb: { get: (id: string) => shares.byId[id] ?? null },
  isShareCode: (v: unknown) => typeof v === "string" && /^[a-z2-9]{10}$/.test(v),
}));
vi.mock("@/components/TranslationProvider", () => ({ useT: () => (k: string) => k }));
vi.mock("@/components/AppSignature", () => ({ AppSignature: () => null }));
vi.mock("@/lib/liquidGlass/useLiquidDelegation", () => ({ useLiquidDelegation: () => {} }));
const navigated = vi.hoisted(() => ({ to: [] as string[] }));
vi.mock("@/lib/signOut", () => ({ hardNavigate: (path: string) => navigated.to.push(path) }));
vi.mock("@/components/shareGuest/ShareTitleView", () => ({ ShareTitleView: () => <div data-testid="fiche" /> }));

import SharePage from "@/app/partage/[code]/page";
import ShareEntryPage from "@/app/partage/page";
import { ShareRedeemForm } from "@/components/shareGuest/ShareRedeemForm";
import { ShareTitleView } from "@/components/shareGuest/ShareTitleView";

const CODE = "abcdefghjk";
const page = (code: string) => SharePage({ params: Promise.resolve({ code }) });

beforeEach(() => {
  cookieValue.token = "t";
  shares.byId = { s1: { code: CODE } };
  navigated.to = [];
  mockVerify.mockReset();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("/partage/<code>, côté serveur", () => {
  it("la session de ce lien : la fiche", async () => {
    mockVerify.mockResolvedValue({ role: "share", sh: "s1" });
    expect((await page(CODE)).type).toBe(ShareTitleView);
    // Le code se lit sans tenir compte de la casse, comme l'entrée.
    expect((await page(CODE.toUpperCase())).type).toBe(ShareTitleView);
  });

  it("sans session, ou celle d'un autre lien : le mot de passe, sans prévenir de rien", async () => {
    mockVerify.mockResolvedValue(null);
    let el = await page(CODE);
    expect(el.type).toBe(ShareRedeemForm);
    expect(el.props).toEqual({ code: CODE, household: false });

    mockVerify.mockResolvedValue({ role: "share", sh: "autre" });
    el = await page(CODE);
    expect(el.type).toBe(ShareRedeemForm);
    expect(el.props.household).toBe(false);
  });

  it("un compte du foyer : le mot de passe, avec l'avertissement", async () => {
    mockVerify.mockResolvedValue({ role: "user", u: "mathis" });
    const el = await page(CODE);
    expect(el.type).toBe(ShareRedeemForm);
    expect(el.props).toEqual({ code: CODE, household: true });
  });

  it("un code qui n'en est pas un : le formulaire complet, comme pour tout autre", async () => {
    mockVerify.mockResolvedValue(null);
    const el = await page("../../etc");
    expect(el.props).toEqual({ code: null, household: false });
  });

  it("/partage : toujours le formulaire avec le champ du code", async () => {
    mockVerify.mockResolvedValue({ role: "admin", u: "louis" });
    const el = await ShareEntryPage();
    expect(el.type).toBe(ShareRedeemForm);
    expect(el.props).toEqual({ code: null, household: true });
  });
});

describe("le formulaire", () => {
  function respond(status: number, body: unknown) {
    const fetchMock = vi.fn(async () => ({ ok: status < 300, status, json: async () => body }));
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("ne dit rien du titre, prévient un compte du foyer, et ouvre la fiche une fois le mot de passe accepté", async () => {
    const fetchMock = respond(200, { ok: true });
    render(<ShareRedeemForm code={CODE} household />);
    expect(screen.getByText("share.guest.tagline")).toBeTruthy();
    expect(screen.getByText("share.guest.householdWarning")).toBeTruthy();
    // Le code est dans l'adresse : seul le mot de passe est demandé.
    expect(document.getElementById("share-code")).toBeNull();
    fireEvent.change(document.getElementById("share-pass")!, { target: { value: "k7fm-2qxp-9tre" } });
    fireEvent.click(screen.getByText("share.guest.submit"));
    await waitFor(() => expect(navigated.to).toEqual([`/partage/${CODE}`]));
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/share/redeem");
    expect(JSON.parse(String(init.body))).toEqual({ code: CODE, password: "k7fm-2qxp-9tre" });
  });

  it("sans code dans l'adresse : le champ du code, mis en minuscules à l'envoi", async () => {
    const fetchMock = respond(200, { ok: true });
    render(<ShareRedeemForm code={null} household={false} />);
    expect(screen.queryByText("share.guest.householdWarning")).toBeNull();
    fireEvent.change(document.getElementById("share-code")!, { target: { value: "ABCDEFGHJK" } });
    fireEvent.change(document.getElementById("share-pass")!, { target: { value: "x" } });
    fireEvent.click(screen.getByText("share.guest.submit"));
    await waitFor(() => expect(navigated.to).toEqual([`/partage/${CODE}`]));
    expect(JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body)).code).toBe(CODE);
  });

  it("un refus, un freinage, une bibliothèque absente : chacun sa phrase, et on reste sur la page", async () => {
    for (const [status, body, text] of [
      [401, { code: "share-refused" }, "share.guest.errors.refused"],
      [400, { code: "share-refused" }, "share.guest.errors.refused"],
      [429, { code: "rate_limited" }, "share.guest.errors.rateLimited"],
      [502, { code: "share-unavailable" }, "share.guest.errors.unavailable"],
    ] as const) {
      respond(status, body);
      render(<ShareRedeemForm code={CODE} household={false} />);
      fireEvent.change(document.getElementById("share-pass")!, { target: { value: "faux" } });
      fireEvent.click(screen.getByText("share.guest.submit"));
      await waitFor(() => expect(screen.getByRole("alert").textContent).toBe(text));
      cleanup();
    }
    expect(navigated.to).toEqual([]);
  });
});
