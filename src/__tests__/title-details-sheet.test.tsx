// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, cleanup, screen, fireEvent, act, within } from "@testing-library/react";
import { SWRConfig } from "swr";
import { createT } from "@/lib/i18n";
import fr from "@/locales/fr.json";
import en from "@/locales/en.json";
import es from "@/locales/es.json";
import de from "@/locales/de.json";
import type { FileStreamsResponse } from "@/app/api/jellyfin/streams/[itemId]/route";

/**
 * La fenêtre « Détails » d'un film (DECISIONS.md §152, 13/11/2026) : trois blocs — l'image, le son, les
 * sous-titres —, l'Atmos tel que le fichier le déclare et sans aucune phrase de réserve (Louis, 13/11/2026),
 * les données demandées à l'ouverture seulement, une erreur dite proprement. Les mots du vrai dictionnaire.
 */
const t = createT(fr as Record<string, unknown>, fr as Record<string, unknown>, "fr");
vi.mock("@/components/TranslationProvider", () => ({ useT: () => t, useLocale: () => ({ locale: "fr", setLocale: async () => {} }) }));
const fetched: string[] = [];
let answer: () => Promise<unknown> = async () => FILE;
vi.mock("@/lib/swr", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/swr")>()),
  fetcher: (url: string) => {
    fetched.push(url);
    return answer();
  },
}));

import { TitleDetailsSheet, subtitleGroups } from "@/components/cinema/TitleDetails";

const FILE: FileStreamsResponse = {
  container: "mkv",
  bitrate: 52_400_000,
  originalLanguage: "en",
  video: { codec: "HEVC", width: 3840, height: 1600, rangeType: "DOVIWithHDR10", bitDepth: 10, dynamicRange: "Dolby Vision", dvProfile: 8 },
  audio: [
    { index: 1, language: "en", title: null, name: "English", codec: "TrueHD", channels: 8, profile: "Dolby TrueHD + Dolby Atmos", forced: false, hearingImpaired: false, atmos: false, isDefault: true, external: false },
    { index: 2, language: "fr", title: "VFF", name: "VFF", codec: "AC3", channels: 6, profile: null, forced: false, hearingImpaired: false, atmos: false, isDefault: false, external: false },
    { index: 3, language: "fr", title: "AD", name: "Français AD", codec: "AAC", channels: 2, profile: null, forced: false, hearingImpaired: false, atmos: false, isDefault: false, external: false },
  ],
  subtitles: [
    { index: 4, language: "fr", title: null, name: "Forced", codec: "SRT", channels: null, forced: true, hearingImpaired: false, atmos: false, isDefault: false, external: false },
    { index: 5, language: "fr", title: null, name: null, codec: "SRT", channels: null, forced: false, hearingImpaired: false, atmos: false, isDefault: false, external: false },
    { index: 6, language: "en", title: null, name: "SDH", codec: "SRT", channels: null, forced: false, hearingImpaired: true, atmos: false, isDefault: false, external: false },
    { index: 7, language: "en", title: null, name: null, codec: "SRT", channels: null, forced: false, hearingImpaired: false, atmos: false, isDefault: false, external: true },
    { index: 8, language: "de", title: null, name: null, codec: "SRT", channels: null, forced: false, hearingImpaired: false, atmos: false, isDefault: false, external: true, generated: true },
  ],
};

const draw = (open: boolean) =>
  render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <TitleDetailsSheet open={open} onClose={vi.fn()} itemId="jf1" tmdbId={603} title="Matrix" logoUrl={null} />
    </SWRConfig>
  );

beforeEach(() => {
  fetched.length = 0;
  answer = async () => FILE;
});
afterEach(() => cleanup());

describe("TitleDetailsSheet", () => {
  it("ne demande rien tant qu'elle est fermée, puis la route du fichier à l'ouverture", async () => {
    const { rerender } = draw(false);
    await act(async () => {});
    expect(fetched).toEqual([]);
    rerender(
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
        <TitleDetailsSheet open onClose={vi.fn()} itemId="jf1" tmdbId={603} title="Matrix" logoUrl={null} />
      </SWRConfig>
    );
    await screen.findByText("4K");
    expect(fetched).toEqual(["/api/jellyfin/streams/jf1?tmdb=603"]);
  });

  it("montre le titre écrit sans logo, et les trois blocs dans l'ordre", async () => {
    draw(true);
    await screen.findByText("4K");
    expect(screen.getByRole("heading", { name: "Matrix" })).toBeTruthy();
    expect([...document.body.querySelectorAll("[data-details-block]")].map((b) => b.getAttribute("data-details-block"))).toEqual(["image", "son", "sous-titres"]);
  });

  it("l'image : définition et dynamique en grand, le codec en petit, le débit et la connexion conseillée", async () => {
    draw(true);
    const block = within(await screen.findByText("4K").then((el) => el.closest<HTMLElement>("[data-details-block]")!));
    expect(block.getByText("Dolby Vision")).toBeTruthy();
    expect(block.getByText("HEVC 10 bits · profil 8")).toBeTruthy();
    const rate = document.body.querySelector("[data-details-bitrate]")!.textContent!;
    expect(rate).toContain("Débit : 52 Mb/s");
    expect(rate).toContain("Connexion conseillée pour la qualité d'origine : 80 Mb/s");
    // Rien sur la taille, les images par seconde ou l'échantillonnage.
    expect(document.body.textContent).not.toMatch(/Go\b|Mo\b|fps|images par seconde|kHz/);
  });

  it("le son : les étiquettes du lecteur, le défaut, l'audiodescription, et l'Atmos tel que déclaré — sans réserve", async () => {
    draw(true);
    await screen.findByText("4K");
    const rows = [...document.body.querySelectorAll<HTMLElement>("[data-details-audio]")];
    expect(rows).toHaveLength(3);
    // `trackLabel` : « Dolby Atmos » pour la piste dont le profil le dit, « (VO) » par la langue de tournage.
    expect(rows[0].textContent).toContain("Anglais (VO) — Dolby Atmos — 7.1");
    expect(rows[0].querySelector("[data-details-atmos]")!.textContent).toBe("Dolby TrueHD + Dolby Atmos");
    expect(rows[0].textContent).toContain("Par défaut");
    expect(rows[1].textContent).toContain("Français — 5.1");
    expect(rows[1].textContent).not.toContain("Par défaut");
    expect(rows[2].textContent).toContain("Audiodescription");
    // Aucune phrase d'avertissement sur le son (consigne du 13/11/2026).
    const sound = document.body.querySelector<HTMLElement>('[data-details-block="son"]')!;
    expect(sound.textContent).not.toMatch(/adapte|appareil|contient|lecteur/i);
  });

  it("les sous-titres : par langue, le type en étiquette, l'externe et le généré signalés", async () => {
    draw(true);
    await screen.findByText("4K");
    const rows = [...document.body.querySelectorAll<HTMLElement>("[data-details-subtitle]")].map((r) => r.textContent);
    expect(rows).toEqual([
      "FrançaisForcésComplets",
      "AnglaisMalentendantsComplets · fichier à part",
      "AllemandComplets · générés par Laterna",
    ]);
  });

  it("compte deux pistes de même étiquette au lieu de les répéter, et met la langue inconnue en dernier", () => {
    const sub = (language: string | null) => ({ ...FILE.subtitles[1], language });
    expect(subtitleGroups([sub(null), sub("fr"), sub("fr")], "fr", t)).toEqual([
      { language: "Français", tags: [{ text: "Complets", count: 2 }] },
      { language: "Langue non précisée", tags: [{ text: "Complets", count: 1 }] },
    ]);
  });

  it("sans débit connu, pas d'encart ; sans piste, une phrase plutôt qu'un bloc vide", async () => {
    answer = async () => ({ ...FILE, bitrate: null, audio: [], subtitles: [] });
    draw(true);
    await screen.findByText("4K");
    expect(document.body.querySelector("[data-details-bitrate]")).toBeNull();
    expect(screen.getByText("Aucune piste son")).toBeTruthy();
    expect(screen.getByText("Aucun sous-titre")).toBeTruthy();
  });

  it("une erreur s'affiche proprement dans la fenêtre", async () => {
    answer = async () => {
      throw new Error("Fichier introuvable");
    };
    draw(true);
    expect(await screen.findByText("Les détails de ce film ne sont pas disponibles pour le moment.")).toBeTruthy();
  });

  it("se referme par sa croix et par Échap", async () => {
    const onClose = vi.fn();
    render(
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
        <TitleDetailsSheet open onClose={onClose} itemId="jf1" title="Matrix" />
      </SWRConfig>
    );
    await screen.findByText("4K");
    fireEvent.click(screen.getByRole("button", { name: "Fermer" }));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});

describe("les mots de la fenêtre", () => {
  it("existent dans les quatre langues, sans vocabulaire d'infrastructure", () => {
    const keys = Object.keys((fr as { cinema: { details: Record<string, string> } }).cinema.details);
    for (const dict of [fr, en, es, de]) {
      const details = (dict as { cinema: { details: Record<string, string> } }).cinema.details;
      expect(Object.keys(details).sort()).toEqual([...keys].sort());
      expect(JSON.stringify(details)).not.toMatch(/dashboard|tableau de bord|\bstack\b|Jellyfin|serveur|server|Servidor/i);
    }
    // L'allemand au vouvoiement.
    expect(JSON.stringify((de as { cinema: { details: unknown } }).cinema.details)).not.toMatch(/\b(du|dein|deine|dich|dir)\b/);
  });
});
