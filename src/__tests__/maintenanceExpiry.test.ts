import { describe, it, expect } from "vitest";

// Ce qui est vérifié ici est la règle d'expiration elle-même, pas SQLite : elle tient en une
// comparaison, et c'est cette comparaison qui décide si dix-neuf écrans portent un bandeau.
describe("l'extinction automatique de la maintenance", () => {
  // Le drapeau sert au moment précis où le conteneur est recréé : un minuteur mourrait donc
  // exactement quand il aurait dû compter. C'est une date en base, comparée à l'heure courante.
  const DUREE = 4 * 60 * 60 * 1000;

  // La règle, telle que `maintenanceDb.get` l'applique.
  const lire = (row: { active: number; notice_at?: number | null; expires_at: number | null } | undefined, now: number) => {
    const expired = row?.expires_at != null && row.expires_at <= now;
    return { active: !!row?.active && !expired };
  };

  it("reste allumée pendant toute la durée", () => {
    const pose = 1_000_000;
    const row = { active: 1, notice_at: null, expires_at: pose + DUREE };
    expect(lire(row, pose).active).toBe(true);
    expect(lire(row, pose + DUREE - 1).active).toBe(true);
  });

  it("s'éteint d'elle-même à l'échéance", () => {
    const pose = 1_000_000;
    const row = { active: 1, notice_at: null, expires_at: pose + DUREE };
    expect(lire(row, pose + DUREE).active).toBe(false);
    expect(lire(row, pose + DUREE + 60_000).active).toBe(false);
  });

  it("s'éteint même après un serveur arrêté toute la nuit", () => {
    // C'est tout l'intérêt d'une date plutôt que d'un minuteur : rien n'a tourné entre-temps.
    const row = { active: 1, notice_at: null, expires_at: 1_000_000 };
    expect(lire(row, 1_000_000 + 12 * 60 * 60 * 1000).active).toBe(false);
  });

  it("ne s'éteint jamais toute seule si aucune échéance n'est posée", () => {
    // Le cas des lignes écrites avant cette colonne : elles gardent le comportement d'avant
    // plutôt que de s'éteindre à la première lecture.
    const row = { active: 1, notice_at: null, expires_at: null };
    expect(lire(row, 9_999_999_999).active).toBe(true);
  });

  it("reste éteinte quand elle est éteinte", () => {
    expect(lire({ active: 0, notice_at: null, expires_at: 1 }, 0).active).toBe(false);
    expect(lire(undefined, 0).active).toBe(false);
  });
});
