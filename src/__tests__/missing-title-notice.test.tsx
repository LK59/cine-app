// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";

const info = vi.fn();
const navigate = vi.fn();
vi.mock("@/components/Toast", () => ({ useToast: () => ({ info, success: vi.fn(), error: vi.fn() }) }));
vi.mock("@/components/TranslationProvider", () => ({ useT: () => (k: string) => k }));
vi.mock("@/lib/cinemaRoute", () => ({ cinemaNavigate: (...a: unknown[]) => navigate(...a) }));

import { useMissingTitleNotice } from "@/lib/useMissingTitleNotice";

beforeEach(() => vi.clearAllMocks());

// *The Arena* (05/10/2026) : une fiche demandée que le catalogue n'avait pas ne se dessinait pas,
// sans un mot.
describe("une fiche que le catalogue n'a pas", () => {
  it("le dit et nettoie l'adresse, une fois le catalogue relu", () => {
    renderHook(() => useMissingTitleNotice({ film: null, serie: 170, movies: new Map(), series: new Map([[1, {}]]) }));
    expect(info).toHaveBeenCalledWith("cinema.titleUnavailable");
    expect(navigate).toHaveBeenCalledWith({ serie: null }, "replace");
  });

  it("attend la relecture au réseau : le catalogue gardé sur l'appareil peut dater", () => {
    renderHook(() => useMissingTitleNotice({ film: null, serie: 170, movies: null, series: null }));
    expect(info).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });

  it("ne dit rien d'une fiche que le catalogue a", () => {
    renderHook(() => useMissingTitleNotice({ film: 12, serie: null, movies: new Map([[12, {}]]), series: null }));
    expect(info).not.toHaveBeenCalled();
  });
});
