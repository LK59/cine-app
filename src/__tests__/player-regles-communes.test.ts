// Les règles du lecteur écrites une seule fois après la fusion des doublons (DECISIONS.md §115) :
// ce que chaque module commun rend, à l'identique de ce que ses copies écrivaient.
import { describe, it, expect } from "vitest";
import { rebuildLine } from "@/components/player/nativeHostHelpers";

describe("rebuildLine (§115, ligne rebuild)", () => {
  it("écrit le fichier, puis path, reason, at, puis les ajouts, dans cet ordre", () => {
    const line = rebuildLine({ file: "a.mkv", size: 3 }, "source perdue", 12, { attempt: 2, skipped: false });
    expect(Object.keys(line)).toEqual(["file", "size", "path", "reason", "at", "attempt", "skipped"]);
    expect(line).toEqual({ file: "a.mkv", size: 3, path: "remux", reason: "source perdue", at: 12, attempt: 2, skipped: false });
  });

  it("sans ajout, s'arrête à at", () => {
    expect(Object.keys(rebuildLine({}, "x", 0))).toEqual(["path", "reason", "at"]);
  });
});
