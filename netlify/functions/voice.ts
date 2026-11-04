function fail(message: string, status = 400) {
  return Response.json({ error: message }, { status });
}

export default async function handler(req: Request) {
  let body: {
    apiKey?: string;
    voiceId?: string;
    text?: string;
    model?: string;
    speed?: number;
    previousText?: string;
    nextText?: string;
  };
  try {
    body = await req.json();
  } catch {
    return fail("请求不完整");
  }

  const apiKey = (body.apiKey || "").trim();
  const voiceId = (body.voiceId || "").trim();
  const text = (body.text || "").trim();
  const model = (body.model || "eleven_multilingual_v2").trim();
  const speed =
    typeof body.speed === "number" && body.speed >= 0.7 && body.speed <= 1.2 ? body.speed : undefined;

  if (!apiKey) return fail("语音设置里没有 Key");
  if (!voiceId) return fail("这个人还没有音色 ID");
  if (!text) return fail("这句是空的");

  // 用音色在 ElevenLabs 里自己存的那套参数，跟服务商后台听到的一致
  let voiceSettings: Record<string, unknown> = { stability: 0.5, similarity_boost: 0.75 };
  try {
    const sres = await fetch(
      `https://api.elevenlabs.io/v1/voices/${encodeURIComponent(voiceId)}/settings`,
      { headers: { "xi-api-key": apiKey }, cache: "no-store" }
    );
    if (sres.ok) {
      const vs = await sres.json();
      voiceSettings = {
        stability: typeof vs.stability === "number" ? vs.stability : 0.5,
        similarity_boost: typeof vs.similarity_boost === "number" ? vs.similarity_boost : 0.75,
        style: typeof vs.style === "number" ? vs.style : 0,
        use_speaker_boost: typeof vs.use_speaker_boost === "boolean" ? vs.use_speaker_boost : true,
      };
    }
  } catch {
    // 取不到就用上面的默认值，不挡着出声
  }
  // v3 起都不认 speed，传了会 400
  if (speed && !/v[3-9]/i.test(model)) voiceSettings = { ...voiceSettings, speed };

  // 前后文只有 v3 及以后支持，带上能让整句的语气接得上
  const context: { previous_text?: string; next_text?: string } = {};
  if (/v[3-9]/i.test(model)) {
    if (body.previousText?.trim()) context.previous_text = body.previousText.trim().slice(-200);
    if (body.nextText?.trim()) context.next_text = body.nextText.trim().slice(0, 200);
  }

  try {
    const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}`, {
      method: "POST",
      headers: {
        "xi-api-key": apiKey,
        "content-type": "application/json",
        accept: "audio/mpeg",
      },
      body: JSON.stringify({
        text,
        model_id: model,
        voice_settings: voiceSettings,
        ...context,
      }),
      cache: "no-store",
    });

    if (!res.ok) {
      const detail = await res.text();
      return fail(`ElevenLabs 返回 ${res.status}：${detail.slice(0, 160)}`, 502);
    }

    return new Response(res.body, {
      headers: {
        "content-type": "audio/mpeg",
        "cache-control": "no-store",
      },
    });
  } catch (e) {
    return fail(e instanceof Error ? e.message : "连不上语音服务", 502);
  }
}
