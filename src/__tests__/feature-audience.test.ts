import { describe, it, expect } from "vitest";
import { audienceAllows, parseAudience } from "@/lib/featureAudience";
import { settingProblem } from "@/lib/settings/setup";
import { SETTINGS_BY_KEY } from "@/lib/settings/schema";

// À qui une fonction expérimentale est ouverte (09/11/2026, DECISIONS.md §138 et §139) : une règle, deux
// options — « Poser une question » et les acteurs à l'écran.

describe("parseAudience — les valeurs d'aujourd'hui et d'avant", () => {
  it("`true` d'avant vaut `tous`, `false` et l'inconnu `off`", () => {
    expect(parseAudience("true")).toBe("tous");
    expect(parseAudience("false")).toBe("off");
    expect(parseAudience("")).toBe("off");
    expect(parseAudience(undefined)).toBe("off");
    expect(parseAudience("n'importe")).toBe("off");
    expect(parseAudience("admins")).toBe("admins");
    expect(parseAudience(" Tous ")).toBe("tous");
  });
});

describe("audienceAllows — la porte, côté serveur", () => {
  it("off : personne ; admins : l'administrateur seul ; tous : toute session ; sans session : jamais", () => {
    for (const role of ["admin", "user", "share"]) expect(audienceAllows("off", { role })).toBe(false);
    expect(audienceAllows("admins", { role: "admin" })).toBe(true);
    expect(audienceAllows("admins", { role: "user" })).toBe(false);
    expect(audienceAllows("admins", { role: "share" })).toBe(false);
    expect(audienceAllows("tous", { role: "user" })).toBe(true);
    expect(audienceAllows("tous", { role: "share" })).toBe(true);
    expect(audienceAllows("tous", null)).toBe(false);
  });
});

describe("les deux réglages", () => {
  it("sont des publics, `off` par défaut, et acceptent encore `true`/`false`", () => {
    for (const key of ["ASK_ENABLED", "XRAY_ENABLED"]) {
      expect(SETTINGS_BY_KEY.get(key), key).toMatchObject({ kind: "audience", fallback: "off", inApp: true });
      for (const v of ["off", "admins", "tous", "true", "false"]) expect(settingProblem(key, v), `${key}=${v}`).toBeNull();
      expect(settingProblem(key, "everyone"), key).toBe("invalid");
    }
  });
});
