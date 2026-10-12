import { describe, it, expect, vi, afterEach } from "vitest";
import {
  createJob,
  fetchExternalSubtitles,
  fetchOptions,
  pollJob,
  readOptions,
  resumeJob,
  SubtitleGenError,
} from "@/lib/subtitleGen/client";

/**
 * Le client des routes « Générer des sous-titres » (DECISIONS.md §70), écrit contre le contrat :
 * chaque refus nommé devient un code, et rien d'autre ne sort de lui qu'une `SubtitleGenError`.
 */

afterEach(() => vi.unstubAllGlobals());

const answer = (status: number, body?: unknown) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => {
    if (body === undefined) throw new SyntaxError("pas de JSON");
    return body;
  },
});

function stub(response: unknown) {
  const fn = vi.fn(async () => response);
  vi.stubGlobal("fetch", fn);
  return fn;
}

async function codeOf(promise: Promise<unknown>): Promise<string | null> {
  try {
    await promise;
    return null;
  } catch (error) {
    return error instanceof SubtitleGenError ? error.code : "autre";
  }
}

describe("fetchOptions", () => {
  it("lit les options, les générations et `presented`", async () => {
    const fetchMock = stub(
      answer(200, {
        enabled: true,
        targets: ["fr", "en"],
        existing: ["en"],
        jobs: [
          { jobId: "j1", target: "fr", status: "running", done: 3, total: 10 },
          { jobId: "j2", target: "de", status: "done", done: 5, total: 5, presented: true },
          { jobId: "x", target: "es", status: "inventé" },
        ],
        quota: { used: 2, limit: 30 },
      })
    );
    const options = await fetchOptions("item 1");
    expect(fetchMock).toHaveBeenCalledWith("/api/subtitle-gen/options?itemId=item%201", expect.anything());
    expect(options.enabled).toBe(true);
    expect(options.targets).toEqual(["fr", "en"]);
    expect(options.jobs).toEqual([
      { jobId: "j1", target: "fr", status: "running", done: 3, total: 10, presented: false },
      { jobId: "j2", target: "de", status: "done", done: 5, total: 5, presented: true },
    ]);
    expect(options.quota).toEqual({ used: 2, limit: 30 });
  });

  it("une réponse d'une autre forme ne propose rien, sans lever", () => {
    expect(readOptions("<html>")).toMatchObject({ enabled: false, targets: [], jobs: [] });
    expect(readOptions(null)).toMatchObject({ enabled: false });
  });
});

describe("createJob — les refus du contrat", () => {
  it.each([
    [429, "quota"],
    [402, "budget"],
    [409, "exists"],
    [422, "no-source"],
    [500, "failed"],
  ])("%i donne « %s »", async (status, code) => {
    stub(answer(status, { error: code }));
    expect(await codeOf(createJob({ itemId: "i", target: "fr", position: 12 }))).toBe(code);
  });

  it("envoie la position et rend l'identifiant", async () => {
    const fetchMock = stub(answer(200, { jobId: "j9", status: "preparing" }));
    expect(await createJob({ itemId: "i", target: "fr", position: 12 })).toEqual({ jobId: "j9", status: "preparing" });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/subtitle-gen/jobs");
    expect(JSON.parse(init.body as string)).toEqual({ itemId: "i", target: "fr", position: 12 });
  });

  it("aucune réponse : « network »", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("Failed to fetch"))));
    expect(await codeOf(createJob({ itemId: "i", target: "fr" }))).toBe("network");
  });
});

describe("pollJob", () => {
  it("garde les lignes bien formées et lit `presented`", async () => {
    const fetchMock = stub(
      answer(200, {
        status: "done",
        rev: 7,
        done: 2,
        total: 2,
        cues: [{ i: 0, start: 1, end: 2, text: "Bonjour" }, { i: "x" }, { i: 1, start: 3, end: 4, text: "Salut" }],
        fileUrl: "/api/subtitle-gen/files/j1.vtt",
        presented: true,
      })
    );
    const polled = await pollJob("j1", { since: 3, position: 42, sessionId: "s" });
    expect(polled.cues.map((c) => c.i)).toEqual([0, 1]);
    expect(polled).toMatchObject({ status: "done", rev: 7, presented: true, fileUrl: "/api/subtitle-gen/files/j1.vtt" });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/subtitle-gen/jobs/j1/poll");
    expect(JSON.parse(init.body as string)).toEqual({ since: 3, position: 42, sessionId: "s" });
  });

  it("sans `presented`, il vaut faux", async () => {
    stub(answer(200, { status: "running", rev: 1, done: 0, total: 9, cues: [] }));
    expect((await pollJob("j1", { since: 0 })).presented).toBe(false);
  });
});

describe("resumeJob", () => {
  it("une reprise acceptée sans corps n'est pas un échec", async () => {
    stub(answer(204));
    await expect(resumeJob("j1")).resolves.toBeUndefined();
  });
});

describe("fetchExternalSubtitles", () => {
  it("relit la liste des externes au serveur, sans cache", async () => {
    const fetchMock = stub(
      answer(200, {
        externalSubtitles: [{ id: -3, language: "fr", title: null, url: "/sub", generated: true }],
      })
    );
    const list = await fetchExternalSubtitles("item-1");
    expect(list).toEqual([{ id: -3, language: "fr", title: null, url: "/sub", generated: true }]);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/jellyfin/direct/item-1");
    expect(init.cache).toBe("no-store");
  });
});
