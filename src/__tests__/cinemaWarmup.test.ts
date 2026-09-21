import { describe, it, expect } from "vitest";
import { warmUpUrls } from "@/lib/cinemaWarmup";

// Le budget du préchauffage, compté en titres (21/09/2026).
type Item = { id: number; a: string | null; b: string | null };
const item = (id: number): Item => ({ id, a: `a${id}`, b: `b${id}` });

describe("warmUpUrls", () => {
  it("la une d'abord, puis la tête de chaque rangée, sans doublon", () => {
    const urls = warmUpUrls([item(1)], { r1: [item(1), item(2)], r2: [item(3)] }, (i) => i.id, (i) => [i.a]);
    expect(urls).toEqual(["a1", "a2", "a3"]);
  });

  it("borne en titres, pas en images", () => {
    const many = Array.from({ length: 50 }, (_, i) => item(i));
    const urls = warmUpUrls([], { r: many }, (i) => i.id, (i) => [i.a, i.b], 5);
    // Huit par rangée au plus (tête de rangée), et cinq titres ici : dix images.
    expect(urls).toHaveLength(10);
  });

  it("garde sur le bureau les 120 requêtes d'avant", () => {
    const rows = Object.fromEntries(Array.from({ length: 20 }, (_, r) => [`r${r}`, Array.from({ length: 8 }, (_, i) => item(r * 8 + i))]));
    expect(warmUpUrls([], rows, (i) => i.id, (i) => [i.a, i.b])).toHaveLength(120);
  });

  it("ignore les images absentes", () => {
    expect(warmUpUrls([{ id: 1, a: null, b: "b1" }], {}, (i) => i.id, (i) => [i.a, i.b])).toEqual(["b1"]);
  });
});
