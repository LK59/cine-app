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

describe("la péremption de l'avis de redémarrage", () => {
  // « L'application va redémarrer » ne veut rien dire une heure après. Signalé à l'usage : l'avis
  // dormait en base et sautait au visage du premier écran qui lançait une lecture — un autre
  // compte, un autre appareil — longtemps après que tout soit fini.
  const FENETRE = 2 * 60 * 1000;

  const lire = (notice: number | null, now: number) =>
    notice !== null && now - notice <= FENETRE ? notice : null;

  it("atteint un écran qui lance une lecture juste après", () => {
    // Le sondage est de quinze secondes : quelqu'un qui démarre un film à l'instant où l'on
    // appuie doit être averti.
    expect(lire(1_000_000, 1_000_000)).toBe(1_000_000);
    expect(lire(1_000_000, 1_000_000 + 30_000)).toBe(1_000_000);
  });

  it("cesse d'exister passé sa fenêtre", () => {
    expect(lire(1_000_000, 1_000_000 + FENETRE)).toBe(1_000_000);
    expect(lire(1_000_000, 1_000_000 + FENETRE + 1)).toBeNull();
  });

  it("n'embusque plus personne des heures après", () => {
    // Le symptôme exact : lecture lancée plus tard, sur un compte qui n'avait jamais vu l'avis.
    expect(lire(1_000_000, 1_000_000 + 6 * 60 * 60 * 1000)).toBeNull();
  });

  it("ne dit rien quand aucun avis n'a jamais été levé", () => {
    expect(lire(null, 1_000_000)).toBeNull();
  });
});

