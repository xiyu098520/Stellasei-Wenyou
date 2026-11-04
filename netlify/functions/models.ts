import { appendFile } from "node:fs/promises";
import path from "node:path";
import { normalizeBaseUrl } from "../../lib/baseurl";

type Body = { baseUrl?: string; apiKey?: string };

function fail(message: string, status = 400) {
  return Response.json({ error: message }, { status });
}

export default async function handler(req: Request) {
  let body: Body;
  try {
    body = await req.json();
  } catch {
    return fail("请求不完整");
  }

  const baseUrl = normalizeBaseUrl(body.baseUrl || "");
  const apiKey = (body.apiKey || "").trim();
  if (!baseUrl) return fail("先填地址");
  if (!apiKey) return fail("先填 Key");

  try {
    const res = await fetch(`${baseUrl}/models`, {
      headers: { authorization: `Bearer ${apiKey}` },
      cache: "no-store",
    });
    if (!res.ok) {
      const detail = await res.text();
      return fail(`取模型返回 ${res.status}：${detail.slice(0, 140)}`, 502);
    }
    const data = await res.json();
    const raw = Array.isArray(data?.data) ? data.data : Array.isArray(data?.models) ? data.models : [];
    const models: string[] = raw
      .map((m: unknown) =>
        typeof m === "string" ? m : String((m as { id?: string; name?: string })?.id || (m as { name?: string })?.name || "")
      )
      .filter(Boolean);
    if (!models.length) return fail("这个 Key 下没取到模型", 502);
    const list = Array.from(new Set(models)).sort();
    // 记一份原始清单：显示不全时，看这里就知道是接口给得少，还是界面没画出来
    void appendFile(
      path.join(process.cwd(), ".cache-log.jsonl"),
      JSON.stringify({ at: new Date().toISOString(), kind: "models", url: `${baseUrl}/models`, count: list.length, ids: list }) + "\n",
      "utf8",
    ).catch(() => {});
    return Response.json({ models: list });
  } catch (e) {
    return fail(e instanceof Error ? e.message : "连不上服务商", 502);
  }
}
