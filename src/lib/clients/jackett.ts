import { config } from "@/lib/config";
import { HttpError } from "@/lib/http";

const { url, apiKey } = config.jackett;

export interface JackettIndexer {
  id: string;
  name: string;
  description: string;
  type: string;
  configured: boolean;
  site_link: string;
  caps: Record<string, unknown>;
}

function decodeEntities(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .trim();
}

// Jackett's "dashboard" listing endpoint (/api/v2.0/indexers) requires an admin
// session cookie and ignores the API key entirely ("400 cookies required").
// The torznab "t=indexers" query against the aggregate "all" indexer is the
// only way to list configured indexers using just the API key — and per
// Jackett's source (ResultsController.Torznab), it replies with a plain XML
// document, not JSON:
// <indexers><indexer id=".." configured="true"><title>..</title>...</indexer></indexers>
function parseIndexersXml(xml: string): JackettIndexer[] {
  const indexers: JackettIndexer[] = [];
  const blockRegex = /<indexer\b([^>]*)>([\s\S]*?)<\/indexer>/g;
  let match: RegExpExecArray | null;
  while ((match = blockRegex.exec(xml))) {
    const [, attrs, body] = match;
    const id = attrs.match(/\bid="([^"]*)"/)?.[1] ?? "";
    const configured = attrs.match(/\bconfigured="([^"]*)"/)?.[1] === "true";
    const extract = (tag: string) =>
      body.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`))?.[1] ?? "";
    indexers.push({
      id,
      configured,
      name: decodeEntities(extract("title")) || id,
      description: decodeEntities(extract("description")),
      site_link: decodeEntities(extract("link")),
      type: decodeEntities(extract("type")),
      caps: {},
    });
  }
  return indexers;
}

async function fetchXml(requestUrl: string, timeoutMs = 8000): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(requestUrl, { signal: controller.signal, cache: "no-store" });
    const body = await res.text();
    if (!res.ok) {
      throw new HttpError(`${res.status} ${res.statusText}: ${body.slice(0, 200)}`, res.status);
    }
    return body;
  } finally {
    clearTimeout(timer);
  }
}

export const jackett = {
  getIndexers: async () => {
    const xml = await fetchXml(
      `${url}/api/v2.0/indexers/all/results/torznab/api?apikey=${encodeURIComponent(apiKey)}&t=indexers&configured=true`
    );
    return parseIndexersXml(xml);
  },
  testIndexer: async (id: string): Promise<boolean> => {
    try {
      await fetchXml(
        `${url}/api/v2.0/indexers/${id}/results/torznab/api?apikey=${encodeURIComponent(apiKey)}&t=caps`,
        5000
      );
      return true;
    } catch {
      return false;
    }
  },
};
