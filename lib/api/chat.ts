import { normalizeBaseUrl } from "../baseurl";

// 这个中转试过一次原生接口、不通，就不再每条都试（进程重启会重来）
let nativeBroken = false;

type Block = { type: "text"; text: string; cache_control?: { type: "ephemeral" } };
type InMsg = { role: string; content: string | Block[] };

type Body = {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  messages?: InMsg[];
  maxTokens?: number;
  json?: boolean;
  stream?: boolean;
};

const asText = (c: string | Block[] | undefined) =>
  typeof c === "string" ? c : Array.isArray(c) ? c.map((b) => b?.text || "").join("\n\n") : "";

// 只给 prompt_cache_key 用的稳定指纹：同一段对话永远算出同一个串就行，不需要密码学强度。
// 原来的 node:crypto 在 Cloudflare 上不可用，这里换成 FNV-1a 拼四段。
const fnv = (s: string) => {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
};
const fp = (s: string) => `${fnv(s)}${fnv(`a|${s}`)}${fnv(`b|${s}`)}${fnv(`c|${s}`)}`;

function fail(message: string, status = 400) {
  return Response.json({ error: message }, { status });
}

// Netlify 与 Cloudflare 都只把 Request 交进来，逻辑全放这儿，两个平台共用一份
export async function handleChat(req: Request) {
  let body: Body;
  try {
    body = await req.json();
  } catch {
    return fail("请求不完整");
  }

  const baseUrl = normalizeBaseUrl(body.baseUrl || "");
  const apiKey = (body.apiKey || "").trim();
  const model = (body.model || "").trim();
  const messages = body.messages;

  if (!baseUrl || !apiKey || !model || !Array.isArray(messages) || !messages.length) {
    return fail("文本设置没填全");
  }

  const url = `${baseUrl}/chat/completions`;
  const maxTokens = Number(body.maxTokens) > 0 ? Math.min(Math.round(Number(body.maxTokens)), 8000) : 0;
  // 小助手要正文（JSON 头 + --- + 自由文字），不能强制整段都是 JSON
  const forceJson = body.json !== false;
  // 兼容接口只认字符串，把分块拼回去
  const flat = messages.map((m) => ({ role: m.role, content: asText(m.content) }));

  // OpenAI 系（gpt-*、o1~o4）没有可打的缓存断点，缓存是全自动的前缀匹配。
  // 能做的是给同一段对话一个固定的 prompt_cache_key，让请求始终落到同一块缓存上；
  // key 只能由「不变的头」算出来（模型 + system + 第一条 user），掺进每轮新内容就等于每轮换 key。
  // 实测：给 Gemini 也发这个字段后，中转反而少命中，说明它不吃这个 key，回退成只给 gpt 系发。
  const openaiish = /gpt|chatgpt|^o[1-4](-|$)/i.test(model);
  const cacheKey = fp(
    [
      model,
      flat.find((m) => m.role === "system")?.content || "",
      flat.find((m) => m.role === "user")?.content || "",
    ].join("\u0000"),
  ).slice(0, 32);

  // 长任务（重写/生成章末档案）走流式：一次性等整段 JSON 会被网关掐成 504，
  // 这里只做转发，边收边攒在前端拼起来。
  if (body.stream) {
    const build = (jsonMode: boolean, withKey: boolean) =>
      JSON.stringify({
        model,
        messages: flat,
        temperature: 0.85,
        stream: true,
        ...(maxTokens ? { max_tokens: maxTokens } : {}),
        // 档案要的是结构化的 JSON，模型进了 JSON 模式才不会自由发挥编事件
        ...(jsonMode ? { response_format: { type: "json_object" } } : {}),
        ...(/gemini/i.test(model) ? { reasoning_effort: "medium" } : {}),
        ...(withKey && openaiish ? { prompt_cache_key: cacheKey } : {}),
      });
    const send = (jsonMode: boolean, withKey: boolean) =>
      fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiKey}`,
        },
        body: build(jsonMode, withKey),
        cache: "no-store",
        signal: AbortSignal.timeout(240_000),
      });
    try {
      let res = await send(body.json !== false, true);
      // 有的中转不认 response_format 或 prompt_cache_key，400 时退回普通模式重试一次
      if (!res.ok && res.status === 400 && body.json !== false) {
        await res.text().catch(() => "");
        res = await send(false, false);
      }
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        return fail(`模型返回 ${res.status}：${detail.slice(0, 160)}`, 502);
      }
      return new Response(res.body, {
        headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store" },
      });
    } catch (e) {
      const timeout = e instanceof Error && e.name === "TimeoutError";
      return fail(timeout ? "上游四分钟没回话，再试一次。" : e instanceof Error ? e.message : "连不上模型", 502);
    }
  }

  // Claude 走中转时，兼容接口不会替我们打断点，缓存只能建、读不到。
  // 这里优先走 Anthropic 原生 /messages，自己打断点：
  // 断点打在「system 末尾」和「历史末尾」——这两段一字不差、只往后追加，下一回合才读得到。
  if (/claude|opus|sonnet|haiku/i.test(model) && !nativeBroken) {
    try {
      const sys = flat.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
      const rest = messages.filter((m) => m.role !== "system");
      // 只有「最后一个 assistant 回合」之前的整段是不变的：下一回合原文还在。
      // 最后一条 user 里装着关系、近况这些每回合都变的东西，打点只建不读。
      let markAt = -1;
      rest.forEach((m, i) => {
        if (m.role === "assistant") markAt = i;
      });
      const out = rest.map((m, mi) => {
        const blocks: Block[] =
          typeof m.content === "string" ? [{ type: "text", text: m.content }] : m.content.map((b) => ({ ...b }));
        if (mi === markAt && blocks.length) blocks[blocks.length - 1].cache_control = { type: "ephemeral" };
        return { role: m.role, content: blocks };
      });
      const nres = await fetch(`${baseUrl}/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": apiKey,
          authorization: `Bearer ${apiKey}`,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model,
          max_tokens: maxTokens || 1600,
          temperature: 0.85,
          ...(sys
            ? { system: [{ type: "text", text: sys, cache_control: { type: "ephemeral" } }] }
            : {}),
          messages: out,
        }),
        cache: "no-store",
      });
      if (nres.ok) {
        const nd = await nres.json();
        const text = Array.isArray(nd?.content)
          ? nd.content
              .map((p: { type?: string; text?: string }) => (p?.type === "text" ? p.text || "" : ""))
              .join("")
          : "";
        if (text.trim()) return Response.json({ content: text });
      } else {
        // 这个中转没开原生接口，记下来，之后不再试
        nativeBroken = true;
      }
    } catch {
      nativeBroken = true;
    }
  }
  const base = {
    model,
    messages: flat,
    temperature: 0.85,
    ...(maxTokens ? { max_tokens: maxTokens } : {}),
  };

  // 三档实测：low 完全不想（写出来发笨），high 会想满额度把正文挤掉，
  // 只有 medium 稳在 2100–2500、27 秒左右、正文八百字。固定 medium。
  const geminiish = /gemini/i.test(model);

  async function call(withFormat: boolean, withEffort = geminiish, withKey = true) {
    const payload = {
      ...base,
      ...(withEffort ? { reasoning_effort: "medium" } : {}),
      ...(withFormat ? { response_format: { type: "json_object" } } : {}),
      ...(withKey && openaiish ? { prompt_cache_key: cacheKey } : {}),
    };
    return fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(payload),
      cache: "no-store",
      // 上游一直不回来时不要无限等：四分钟就放弃，把错误交回页面
      // （默认思考量大的时候，一回合实测要两分钟左右）
      signal: AbortSignal.timeout(240_000),
    });
  }

  try {
    let res = await call(forceJson);
    if (!res.ok && res.status === 400) {
      // 有些兼容接口不认 response_format、reasoning_effort 或 prompt_cache_key，全都去掉再要一次
      await res.text().catch(() => "");
      res = await call(false, false, false);
    }
    if (!res.ok) {
      const detail = await res.text();
      return fail(`模型返回 ${res.status}：${detail.slice(0, 160)}`, 502);
    }
    const data = await res.json();
    const choice = data?.choices?.[0];
    const msg = choice?.message;
    let content = msg?.content;
    if (Array.isArray(content)) {
      content = content
        .map((p: { text?: string } | string) => (typeof p === "string" ? p : p?.text || ""))
        .join("");
    }
    if (typeof content !== "string" || !content.trim()) {
      // JSON 模式下有的模型会回空内容，退回普通请求再要一次
      if (forceJson) {
        const res2 = await call(false);
        if (res2.ok) {
          const data2 = await res2.json();
          const c2 = data2?.choices?.[0]?.message?.content;
          if (typeof c2 === "string" && c2.trim()) return Response.json({ content: c2 });
        }
      }
      const why = choice?.finish_reason ? `，结束原因 ${choice.finish_reason}` : "";
      return fail(`模型回了空内容${why}。模型：${model}`, 502);
    }
    return Response.json({ content });
  } catch (e) {
    const timeout = e instanceof Error && e.name === "TimeoutError";
    return fail(timeout ? "上游四分钟没回话，再试一次。" : e instanceof Error ? e.message : "连不上模型", 502);
  }
}
