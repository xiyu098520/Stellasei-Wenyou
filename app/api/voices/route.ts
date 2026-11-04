import { NextRequest } from "next/server";

export const runtime = "nodejs";

type Body = { apiKey?: string };

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

  const apiKey = (body.apiKey || "").trim();
  if (!apiKey) return fail("先填 Key");

  try {
    const res = await fetch("https://api.elevenlabs.io/v1/voices", {
      headers: { "xi-api-key": apiKey },
      cache: "no-store",
    });
    if (!res.ok) {
      const detail = await res.text();
      if (res.status === 401 || res.status === 403 || detail.includes("voices_read")) {
        return fail("这把 Key 没有 Voices 读取权限。去 ElevenLabs → API Keys 编辑这把 Key，把 Voices 勾成 Read。", 403);
      }
      return fail(`取音色返回 ${res.status}：${detail.slice(0, 140)}`, 502);
    }
    const data = await res.json();
    const voices = (data?.voices || [])
      .map((v: { voice_id?: string; name?: string }) => ({
        id: String(v.voice_id || ""),
        name: String(v.name || v.voice_id || ""),
      }))
      .filter((v: { id: string }) => v.id);
    if (!voices.length) return fail("这个 Key 下没取到音色", 502);
    return Response.json({ voices });
  } catch (e) {
    return fail(e instanceof Error ? e.message : "连不上 ElevenLabs", 502);
  }
}
