import { describe, it, expect, vi } from "vitest";
import type { NextRequest } from "next/server";

/**
 * L'option de la recherche de répliques (DECISIONS.md §88) : le serveur refuse de l'allumer tant que
 * le dossier des films n'est pas lisible — la page grise l'interrupteur, mais l'interface n'est pas
 * une garde.
 */

// Un dossier à soi : le PUT écrit le réglage dans la base, qui ne doit pas déborder sur d'autres fichiers.
vi.hoisted(() => {
  const { mkdtempSync } = require("node:fs") as typeof import("node:fs");
  const { tmpdir } = require("node:os") as typeof import("node:os");
  process.env.DATA_DIR = mkdtempSync(`${tmpdir()}/repliques-settings-`);
});

const state = vi.hoisted(() => ({ mountOk: false }));
vi.mock("@/lib/server-cache", () => ({ invalidateByPrefix: () => {} }));
vi.mock("@/lib/repliques/library", () => ({
  checkMoviesMount: async () => ({ ok: state.mountOk, problem: state.mountOk ? null : "not-mounted" }),
}));

import { PUT } from "@/app/api/settings/route";
import { config } from "@/lib/config";

describe("PUT /api/settings — l'option", () => {
  function put(values: Record<string, string>): NextRequest {
    return { json: async () => ({ values }) } as unknown as NextRequest;
  }
  it("refuse de l'allumer sans dossier des films lisible", async () => {
    state.mountOk = false;
    const res = await PUT(put({ REPLIQUES_ENABLED: "true" }));
    expect(res.status).toBe(400);
    expect((await res.json()).errors).toEqual({ REPLIQUES_ENABLED: "unavailable" });
  });
  it("laisse l'éteindre à tout moment, et l'allume quand le dossier se lit", async () => {
    state.mountOk = false;
    expect((await PUT(put({ REPLIQUES_ENABLED: "false" }))).status).toBe(200);
    state.mountOk = true;
    expect((await PUT(put({ REPLIQUES_ENABLED: "true" }))).status).toBe(200);
    expect(config.repliques.enabled).toBe(true);
  });
});
