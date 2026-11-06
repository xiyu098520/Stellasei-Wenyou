type Body = { apiKey?: string };

function fail(message: string, status = 400) {
  return Response.json({ error: message }, { status });
}

export async function handleVoiceModels(req: Request) {
  let body: Body;
  try {
    body = await req.json();
  } catch {
    return fail("请求不完整");
  }

  const apiKey = (body.apiKey || "").trim();
  if (!apiKey) return fail("先填 Key");

  try {
    const res = await fetch("https://api.elevenlabs.io/v1/models", {
      headers: { "xi-api-key": apiKey },
      cache: "no-store",
    });
    if (!res.ok) {
      const detail = await res.text();
      if (res.status === 401 || res.status === 403 || detail.includes("models_read")) {
        return fail("这把 Key 没有 Models 读取权限。去 ElevenLabs → API Keys 编辑这把 Key，把 Models 勾成 Read，再回来取。", 403);
      }
      return fail(`取模型返回 ${res.status}：${detail.slice(0, 140)}`, 502);
    }
    const data = await res.json();
    const list = Array.isArray(data) ? data : Array.isArray(data?.models) ? data.models : [];
    const models = list
      .filter((m: { can_do_text_to_speech?: boolean }) => m?.can_do_text_to_speech !== false)
      .map((m: { model_id?: string; name?: string }) => ({
        id: String(m.model_id || ""),
        name: String(m.name || m.model_id || ""),
      }))
      .filter((m: { id: string }) => m.id);
    if (!models.length) return fail("这个 Key 下没取到语音模型", 502);
    return Response.json({ models });
  } catch (e) {
    return fail(e instanceof Error ? e.message : "连不上 ElevenLabs", 502);
  }
}
