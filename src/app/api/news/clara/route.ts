import { NextResponse } from "next/server";
import { withCache } from "@/lib/server-cache";

export const dynamic = "force-dynamic";

export interface NewsArticle {
  title: string;
  link: string;
  pubDate: string;
  source: string;
}

function cdata(s: string): string {
  return s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").trim();
}

async function fetchNews(): Promise<NewsArticle[]> {
  const url = "https://news.google.com/rss/search?q=Clara+Gall%C3%A9&hl=fr&gl=FR&ceid=FR:fr";
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) return [];
  const xml = await res.text();
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].slice(0, 12).map((m) => {
    const inner = m[1];
    const title = cdata(inner.match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? "");
    const rawLink = inner.match(/<link\s*\/?>([\s\S]*?)<\/link>/)?.[1]
      ?? inner.match(/<link\/>\s*(https?[^\s<]+)/)?.[1]
      ?? "";
    const link = rawLink.trim();
    const pubDate = cdata(inner.match(/<pubDate>([\s\S]*?)<\/pubDate>/)?.[1] ?? "");
    const source = cdata(inner.match(/<source[^>]*>([\s\S]*?)<\/source>/)?.[1] ?? "");
    return { title, link, pubDate, source };
  }).filter((a) => a.title && a.link);
}

export async function GET() {
  try {
    const articles = await withCache("news:clara", 60 * 60_000, fetchNews);
    return NextResponse.json({ articles });
  } catch {
    return NextResponse.json({ articles: [] });
  }
}
