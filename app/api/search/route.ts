import { NextRequest } from "next/server";

export const runtime = "nodejs";

type Body = {
  provider?: string;
  apiKey?: string;
  query?: string;
};

type Hit = { title: string; url: string; snippet: string };

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + "…" : s);

function fail(message: string, status = 400) {
  return Response.json({ error: message }, { status });
}

export async function POST(req: NextRequest) {
  let body: Body;
  try {
    body = await req.json();
  } catch {
    return fail("请求不完整");
  }

  const provider = body.provider === "tavily" ? "tavily" : "bocha";
  const apiKey = (body.apiKey || "").trim();
  const query = (body.query || "").trim();

  if (!apiKey) return fail("先填搜索 Key");
  if (!query) return fail("没给要查的词");

  try {
    let hits: Hit[] = [];

    if (provider === "tavily") {
      const res = await fetch("https://api.tavily.com/search", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          api_key: apiKey,
          query,
          max_results: 8,
          search_depth: "basic",
          include_answer: false,
        }),
        cache: "no-store",
      });
      if (!res.ok) {
        const detail = await res.text();
        return fail(`搜索返回 ${res.status}：${detail.slice(0, 160)}`, 502);
      }
      const data = await res.json();
      hits = (data?.results || []).map((r: { title?: string; url?: string; content?: string }) => ({
        title: String(r.title || ""),
        url: String(r.url || ""),
        snippet: clip(String(r.content || ""), 700),
      }));
    } else {
      const res = await fetch("https://api.bochaai.com/v1/web-search", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ query, count: 8, summary: true, freshness: "noLimit" }),
        cache: "no-store",
      });
      if (!res.ok) {
        const detail = await res.text();
        return fail(`搜索返回 ${res.status}：${detail.slice(0, 160)}`, 502);
      }
      const data = await res.json();
      const pages = data?.data?.webPages?.value || data?.webPages?.value || [];
      hits = pages.map(
        (r: { name?: string; url?: string; snippet?: string; summary?: string }) => ({
          title: String(r.name || ""),
          url: String(r.url || ""),
          snippet: clip(String(r.summary || r.snippet || ""), 700),
        })
      );
    }

    hits = hits.filter((h) => h.snippet.trim()).slice(0, 8);
    if (!hits.length) return fail("没查回东西，换个词试试", 502);
    return Response.json({ results: hits });
  } catch (e) {
    return fail(e instanceof Error ? e.message : "连不上搜索", 502);
  }
}
