// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

/**
 * « Analyser en priorité » sur la fiche d'un titre (DECISIONS.md §138, liste de priorité) : présenté à
 * l'administrateur seul, l'option branchée ; un appui ajoute le titre et le confirme discrètement ;
 * l'animation est refusée avec sa raison. La route reste la porte (`xray-scan-route.test.ts`).
 */

const state = vi.hoisted(() => ({ available: true, role: "admin" as string | undefined }));
vi.mock("@/lib/xray/client", () => ({ useXrayAvailable: () => state.available }));
vi.mock("@/lib/useRole", () => ({ useRole: () => ({ role: state.role }) }));
vi.mock("@/components/TranslationProvider", () => ({ useT: () => (key: string) => key }));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("@/components/Toast", () => ({ useToast: () => toast }));

import { XrayPriorityControl } from "@/components/cinema/XrayPriorityControl";

const ITEM = "a".repeat(32);
const fetchMock = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(state, { available: true, role: "admin" });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

describe("le bouton de la fiche", () => {
  it("n'existe que pour un administrateur, l'option branchée", () => {
    state.role = "user";
    const { container, rerender } = render(<XrayPriorityControl itemId={ITEM} variant="round" />);
    expect(container.innerHTML).toBe("");
    state.role = "admin";
    state.available = false;
    rerender(<XrayPriorityControl itemId={ITEM} variant="round" />);
    expect(container.innerHTML).toBe("");
  });

  it("ajoute le titre et le confirme", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({}) });
    render(<XrayPriorityControl itemId={ITEM} variant="round" />);
    fireEvent.click(screen.getByRole("button", { name: "xrayScan.prioritize" }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("xrayScan.prioritized"));
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ action: "prioritize", itemId: ITEM });
  });

  it("l'animation : refusée, et le message le dit", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 409, json: async () => ({ error: "animation" }) });
    render(<XrayPriorityControl itemId={ITEM} variant="icon" />);
    fireEvent.click(screen.getByRole("button", { name: "xrayScan.prioritize" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("xrayScan.animationRefused"));
  });
});
