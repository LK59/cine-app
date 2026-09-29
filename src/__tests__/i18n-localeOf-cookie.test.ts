import { describe, it, expect } from "vitest";
import { localeOf } from "@/lib/i18n";

// Un cookie `cine-lang` mal encodé (posable par un sous-domaine voisin) faisait lever URIError
// dans `localeOf`, et le catalogue répondait 502 alors que l'écran s'affichait. [A17]
function req(cookie: string) {
  return { headers: { get: (n: string) => (n === "cookie" ? cookie : null) } };
}

describe("localeOf et un cookie de langue mal encodé", () => {
  it("retombe sur le français au lieu de lever", () => {
    expect(() => localeOf(req("cine-lang=%E0"))).not.toThrow();
    expect(localeOf(req("cine-lang=%E0"))).toBe("fr");
  });

  it("lit toujours une langue valide", () => {
    expect(localeOf(req("a=b; cine-lang=de"))).toBe("de");
  });
});
