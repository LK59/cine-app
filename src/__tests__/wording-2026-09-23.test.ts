import { describe, it, expect } from "vitest";
import { createT } from "@/lib/i18n";
import { departmentLabel } from "@/lib/personDepartment";
import { deviceLabel } from "@/lib/deviceLabel";
import fr from "@/locales/fr.json";
import en from "@/locales/en.json";

// Relevé à l'écran le 23/09/2026 : « 3 autre(s) appareil(s) connecté(s). », « Acting » sous le
// nom d'une actrice, et des appareils connectés qu'on ne pouvait pas reconnaître.

describe("le singulier et le pluriel", () => {
  const tFr = createT(fr, fr, "fr");
  const tEn = createT(en, fr, "en");

  it("choisit la forme par la règle de la langue — zéro est singulier en français", () => {
    expect(tFr("player.account.otherDevices", { n: 1 })).toBe("1 autre appareil connecté.");
    expect(tFr("player.account.otherDevices", { n: 3 })).toBe("3 autres appareils connectés.");
    expect(tFr("cinema.seasonCount", { n: 0 })).toBe("0 saison");
    expect(tEn("cinema.seasonCount", { n: 0 })).toBe("0 seasons");
    expect(tEn("cinema.seasonCount", { n: 1 })).toBe("1 season");
  });

  it("ne laisse plus aucun « (s) » dans les traductions françaises", () => {
    expect(JSON.stringify(fr)).not.toContain("(s)");
  });

  it("une chaîne sans deux formes passe telle quelle", () => {
    expect(tFr("player.account.notifTest")).toBe("Envoyer un test");
  });
});

describe("le métier d'une personne", () => {
  const t = createT(fr, fr, "fr");
  it("se traduit", () => {
    expect(departmentLabel(t, "Acting")).toBe("Interprétation");
    expect(departmentLabel(t, "Directing")).toBe("Réalisation");
  });
  it("se tait plutôt que d'afficher un mot anglais inconnu", () => {
    expect(departmentLabel(t, "Something New")).toBeNull();
    expect(departmentLabel(t, null)).toBeNull();
  });
});

describe("l'appareil d'une session", () => {
  it("se lit en deux mots", () => {
    expect(deviceLabel("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1")).toBe("iPhone · Safari");
    expect(deviceLabel("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36")).toBe("Windows · Chrome");
    expect(deviceLabel("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0")).toBe("Windows · Edge");
    expect(deviceLabel("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15")).toBe("Mac · Safari");
    expect(deviceLabel("Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0")).toBe("Linux · Firefox");
    expect(deviceLabel("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/140.0 Mobile/15E148 Safari/604.1")).toBe("iPhone · Chrome");
  });
  it("rien plutôt qu'un libellé inventé", () => {
    expect(deviceLabel(null)).toBeNull();
    expect(deviceLabel("curl/8.0")).toBeNull();
  });
});
