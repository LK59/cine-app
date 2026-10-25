import { describe, it, expect, vi } from "vitest";
import { taskLine, taskLog } from "@/lib/taskLog";

/**
 * Les lignes des tâches de fond dans le journal du conteneur (25/10/2026) : lisibles à l'œil, une
 * ligne, quelques détails — jamais l'objet JSON de `server.log`.
 */
describe("taskLine", () => {
  it("nomme la tâche, dit l'action, puis les détails utiles", () => {
    expect(taskLine("sauvegarde", "base copiée", { fichier: "cine-2026-10-25.db", Mo: 12, s: 1.234 })).toBe(
      "[sauvegarde] base copiée · fichier=cine-2026-10-25.db · Mo=12 · s=1.2"
    );
  });

  it("tait les détails vides, résume les listes et coupe les valeurs longues", () => {
    const line = taskLine("notifications", "envoyée", { pour: ["louis", "oscar"], vide: null, rien: "", objet: { a: 1 }, long: "x".repeat(200) });
    expect(line).toContain("pour=louis, oscar");
    expect(line).not.toContain("vide=");
    expect(line).not.toContain("objet=");
    expect(line).toMatch(/long=x{79}…$/);
  });

  it("au plus six détails", () => {
    const many = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`k${i}`, i]));
    expect(taskLine("t", "m", many).split(" · ")).toHaveLength(7);
  });

  it("écrit dans la console", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    taskLog("torrents", "terminé", { nom: "Film" });
    expect(spy).toHaveBeenCalledWith("[torrents] terminé · nom=Film");
    spy.mockRestore();
  });
});
