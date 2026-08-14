import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/server-cache", () => ({
  withCache: async (_key: string, _ttl: number, fn: () => unknown) => fn(),
}));

const originalFetch = global.fetch;
beforeEach(() => vi.clearAllMocks());
afterEach(() => { global.fetch = originalFetch; });

const SAMPLE_RSS = `<?xml version="1.0"?><rss><channel>
<item>
  <title><![CDATA[Clara Galle at an event]]></title>
  <link>https://example.com/article</link>
  <pubDate>Mon, 01 Jan 2024 00:00:00 GMT</pubDate>
  <source url="https://example.com">Example News</source>
</item>
</channel></rss>`;

describe("GET /api/news/clara", () => {
  it("parses title/link/pubDate/source out of the RSS XML", async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: true, text: async () => SAMPLE_RSS });
    const { GET } = await import("@/app/api/news/clara/route");
    const res = await GET();
    const body = await res.json();
    expect(body.articles).toHaveLength(1);
    expect(body.articles[0]).toMatchObject({
      title: "Clara Galle at an event",
      link: "https://example.com/article",
      source: "Example News",
    });
  });

  it("returns an empty list when the upstream fetch fails", async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error("network down"));
    const { GET } = await import("@/app/api/news/clara/route");
    const res = await GET();
    expect((await res.json()).articles).toEqual([]);
  });

  it("returns an empty list when Google News responds with a non-ok status", async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false });
    const { GET } = await import("@/app/api/news/clara/route");
    const res = await GET();
    expect((await res.json()).articles).toEqual([]);
  });
});
