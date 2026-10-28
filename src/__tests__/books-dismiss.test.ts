import { describe, it, expect, vi } from "vitest";

// Sa propre base : la table des positions est écrite ici à chaque test.
await vi.hoisted(async () => {
  const fsp = await import("node:fs");
  const os = await import("node:os");
  const p = await import("node:path");
  process.env.DATA_DIR = fsp.mkdtempSync(p.join(os.tmpdir(), "laterna-books-dismiss-"));
});

import { dismissedAt, dismissProgress, progressByBook, readProgress, saveProgress } from "@/lib/books/progress";
import { buildIndex, resumeFrom } from "@/lib/books/bookIndex";
import type { LibraryItem } from "@/lib/books/library";

/**
 * « Retirer de Continuer la lecture » (fiche du livre, 28/10/2026) : la position reste, le livre quitte
 * la rangée, et la prochaine page lue l'y remet.
 */
const ID = "a".repeat(32);
const CFI = "epubcfi(/6/4!/4/2/1:0)";

describe("retirer un livre de « Continuer la lecture »", () => {
  it("garde la position, sort le livre de la rangée, et la page suivante l'y remet", async () => {
    saveProgress("louis", ID, CFI, 0.4, false, 1000);
    const index = await buildIndex([{ Id: ID, Name: "Arizona Max", Type: "Book", People: [{ Name: "Robert Muchamore", Type: "Author" }], library: "l" } as LibraryItem]);
    expect(resumeFrom(index, progressByBook("louis")).map((b) => b.id)).toEqual([ID]);

    expect(dismissProgress("louis", ID, 2000)).toBe(2000);
    expect(readProgress("louis", ID)).toMatchObject({ cfi: CFI, fraction: 0.4, dismissed: true });
    expect(resumeFrom(index, progressByBook("louis"))).toEqual([]);
    expect(dismissedAt("louis", ID)).toBe(2000);

    saveProgress("louis", ID, CFI, 0.45, false, 3000);
    expect(readProgress("louis", ID)?.dismissed).toBe(false);
    expect(resumeFrom(index, progressByBook("louis")).map((b) => b.id)).toEqual([ID]);
  });

  it("ne touche qu'au compte qui retire, et rien sans position", () => {
    saveProgress("louis", "b".repeat(32), CFI, 0.2, false, 1000);
    saveProgress("kab", "b".repeat(32), CFI, 0.3, false, 1000);
    dismissProgress("louis", "b".repeat(32), 2000);
    expect(readProgress("kab", "b".repeat(32))?.dismissed).toBe(false);
    expect(dismissProgress("louis", "c".repeat(32), 2000)).toBeNull();
  });
});
