import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const { player, pictureFrameFor } = vi.hoisted(() => ({
  player: { enabled: true, autoFrame: true },
  pictureFrameFor: vi.fn(),
}));
vi.mock("@/lib/config", () => ({ config: { player } }));
vi.mock("@/lib/pictureFrame", () => ({ pictureFrameFor: (id: string) => pictureFrameFor(id) }));
vi.mock("@/lib/logger", () => ({ logError: vi.fn() }));

import { GET } from "@/app/api/player/frame/[itemId]/route";

const ID = "5cc324b7fd203b8995285af2d43a2769";
const call = (id: string) => GET(new NextRequest(`http://x/api/player/frame/${id}`), { params: Promise.resolve({ itemId: id }) });

beforeEach(() => {
  player.autoFrame = true;
  pictureFrameFor.mockReset();
});

describe("GET /api/player/frame/[itemId]", () => {
  it("returns the measured frame", async () => {
    pictureFrameFor.mockResolvedValue({ left: 0, top: 0.09, right: 1, bottom: 0.91, aspect: 1.7778, samples: 500 });
    expect(await (await call(ID)).json()).toEqual({ frame: expect.objectContaining({ top: 0.09 }) });
  });

  // Coupé par PLAYER_AUTO_FRAME=false : rien n'est mesuré, et le lecteur montre le film tel quel.
  it("measures nothing when turned off", async () => {
    player.autoFrame = false;
    expect(await (await call(ID)).json()).toEqual({ frame: null });
    expect(pictureFrameFor).not.toHaveBeenCalled();
  });

  // Une mesure qui échoue ne doit jamais devenir une erreur du lecteur.
  it("answers null when the measure fails", async () => {
    pictureFrameFor.mockRejectedValue(new Error("Jellyfin muet"));
    const res = await call(ID);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ frame: null });
  });

  it("refuses what is not an item id", async () => {
    expect((await call("../etc")).status).toBe(400);
  });
});
