import { describe, it, expect } from "vitest";
import { hydrate } from "@/lib/cinemaPayload";

// La charge utile voyage dédupliquée et se lit complète. Ce qui est vérifié ici est la charnière
// entre les deux — et surtout qu'elle tolère les deux formes, parce que le service worker peut
// resservir une charge enregistrée avant ce changement.

const film = (radarrId: number, title: string) => ({ radarrId, title });
const id = (m: { radarrId: number }) => m.radarrId;

describe("hydrate", () => {
  it("rend les titres là où le fil ne portait que des identifiants", () => {
    const out = hydrate(
      {
        genres: ["Action"],
        items: [film(1, "A"), film(2, "B")],
        rows: { Action: [2, 1] },
        spotlight: [1],
        recentlyAdded: [2],
        top10: [1, 2],
      },
      id
    )!;
    expect(out.rows.Action.map((m) => m.title)).toEqual(["B", "A"]);
    expect(out.spotlight.map((m) => m.title)).toEqual(["A"]);
    expect(out.top10).toHaveLength(2);
  });

  it("partage les objets plutôt que de les recopier", () => {
    // C'est ce qui fait que la déduplication ne coûte rien en mémoire : le même titre cité dans
    // trois rangées est le même objet, pas trois copies.
    const a = film(1, "A");
    const out = hydrate({ genres: [], items: [a], rows: { X: [1], Y: [1] }, spotlight: [], recentlyAdded: [], top10: [] }, id)!;
    expect(out.rows.X[0]).toBe(out.rows.Y[0]);
    expect(out.rows.X[0]).toBe(a);
  });

  it("laisse passer une charge utile d'avant le changement", () => {
    // Le service worker peut en resservir une, et un écran ouvert pendant un déploiement en
    // reçoit une neuve avec du code ancien. Les deux formes doivent vivre côte à côte.
    const a = film(1, "A");
    const out = hydrate({ genres: [], rows: { Action: [a] }, spotlight: [a], recentlyAdded: [], top10: [] }, id)!;
    expect(out.rows.Action[0].title).toBe("A");
    expect(out.spotlight[0].title).toBe("A");
  });

  it("omet un identifiant inconnu plutôt que de laisser un trou", () => {
    const out = hydrate({ genres: [], items: [film(1, "A")], rows: { Action: [1, 99] }, spotlight: [], recentlyAdded: [], top10: [] }, id)!;
    expect(out.rows.Action).toHaveLength(1);
    expect(out.rows.Action[0].title).toBe("A");
  });

  it("ne fabrique rien à partir de rien", () => {
    expect(hydrate(undefined, id)).toBeUndefined();
    const vide = hydrate({ genres: [], items: [], rows: {}, spotlight: [], recentlyAdded: [], top10: [] }, id)!;
    expect(vide.spotlight).toEqual([]);
    expect(vide.rows).toEqual({});
  });
});
