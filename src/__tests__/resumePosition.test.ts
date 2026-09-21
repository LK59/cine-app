import { describe, it, expect, vi, afterEach } from "vitest";
import { resumeAtFor, resolveResumeAt } from "@/lib/resumePosition";

// D'où part une lecture. Un nombre — zéro compris — est une affirmation ; une absence veut dire
// « demande au serveur ». Les confondre a coûté deux bugs opposés le même jour, et un troisième
// le 21/09 : un silence de Jellyfin lu comme « aucune reprise ».

describe("resumeAtFor — ce qu'un appelant peut affirmer", () => {
  it("« Recommencer » dit zéro, même sans rien savoir", () => {
    expect(resumeAtFor({ fromStart: true, known: false, resumeTicks: null })).toBe(0);
    expect(resumeAtFor({ fromStart: true, known: true, resumeTicks: 12_000_000_000 })).toBe(0);
  });

  it("une position connue devient des secondes", () => {
    expect(resumeAtFor({ known: true, resumeTicks: 12_000_000_000 })).toBe(1200);
  });

  it("« connu, sans reprise » dit zéro", () => {
    expect(resumeAtFor({ known: true, resumeTicks: null })).toBe(0);
    expect(resumeAtFor({ known: true, resumeTicks: 0 })).toBe(0);
  });

  it("ne dit rien quand Jellyfin n'a pas répondu, au lieu d'affirmer le début", () => {
    // La route revient `{ known: false, resumeTicks: null }` : ce n'est pas « aucune reprise ».
    expect(resumeAtFor({ known: false, resumeTicks: null })).toBeUndefined();
  });
});

describe("resolveResumeAt — ce que le lecteur fait d'une absence", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("garde tel quel un nombre, zéro compris, sans rien demander", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect(await resolveResumeAt("abc", 0)).toBe(0);
    expect(await resolveResumeAt("abc", 42)).toBe(42);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("demande la position au serveur quand l'appelant l'ignorait", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ resumeSeconds: 1830, preferences: null }) }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await resolveResumeAt("abc", undefined)).toBe(1830);
    expect(fetchMock).toHaveBeenCalledWith("/api/jellyfin/playback-state/abc", expect.anything());
  });

  it("ouvre au début plutôt que pas du tout quand le serveur échoue", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false })));
    expect(await resolveResumeAt("abc", undefined)).toBe(0);
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("réseau"); }));
    expect(await resolveResumeAt("abc", undefined)).toBe(0);
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => null })));
    expect(await resolveResumeAt("abc", undefined)).toBe(0);
  });
});
