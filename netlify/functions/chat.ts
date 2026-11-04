import { normalizeBaseUrl } from "../../lib/baseurl";
import { appendFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";

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
};

const asText = (c: string | Block[] | undefined) =>
  typeof c === "string" ? c : Array.isArray(c) ? c.map((b) => b?.text || "").join("\n\n") : "";

// 命中没命中，看 usage 最准：cache_read_input_tokens 大于 0 才算真读到。
async function logUsage(kind: string, model: string, usage: unknown, extra?: unknown) {
  try {
    const line =
      JSON.stringify({ at: new Date().toISOString(), kind, model, usage, ...(extra ? { extra } : {}) }) + "\n";
    await appendFile(path.join(process.cwd(), ".cache-log.jsonl"), line, "utf8");
  } catch {
    /* 日志写不进去不影响出字（Netlify 上工作目录只读，这里本来也写不进去） */
  }
}

const fp = (s: string) => createHash("sha1").update(s).digest("hex").slice(0, 8);

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
  const model = (body.model || "").trim();
  const messages = body.messages;

  if (!baseUrl || !apiKey || !model || !Array.isArray(messages) || !messages.length) {
    return fail("文本设置没填全");
  }

  const url = `${baseUrl}/chat/completions`;
  // 每条请求一进来就记一笔：卡住时能分清是「根本没发出去」还是「上游一直不回」
  const t0 = Date.now();
  void logUsage("start", model, null, { msgs: messages.length, maxTokens: body.maxTokens });
  const maxTokens = Number(body.maxTokens) > 0 ? Math.min(Math.round(Number(body.maxTokens)), 4000) : 0;
  // 小助手要正文（JSON 头 + --- + 自由文字），不能强制整段都是 JSON
  const forceJson = body.json !== false;
  // 兼容接口只认字符串，把分块拼回去
  const flat = messages.map((m) => ({ role: m.role, content: asText(m.content) }));

  // OpenAI 系（gpt-*、o1~o4）没有可打的缓存断点，缓存是全自动的前缀匹配。
  // 能做的是给同一段对话一个固定的 prompt_cache_key，让请求始终落到同一块缓存上；
  // key 只能由「不变的头」算出来（模型 + system + 第一条 user），掺进每轮新内容就等于每轮换 key。
  const openaiish = /gpt|chatgpt|^o[1-4](-|$)/i.test(model);
  const cacheKey = createHash("sha1")
    .update(
      [
        model,
        flat.find((m) => m.role === "system")?.content || "",
        flat.find((m) => m.role === "user")?.content || "",
      ].join("\u0000"),
    )
    .digest("hex")
    .slice(0, 32);

  // 每块记一个累计指纹：下一回合同一段文本的指纹必须一模一样，前缀缓存才可能命中。
  // 对不上 = 我们这边的 prompt 在变；对得上但 cached_tokens 还是 0 = 中转站没做缓存。
  const compatShape: string[] = [];
  let pacc = fp("");
  for (const m of flat) {
    pacc = fp(`${pacc}|${m.role}|${m.content}`);
    compatShape.push(`${m.role}:${m.content.length}:${pacc}`);
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
      // 每块记一个「累计指纹」：下一回合同一段文本的指纹必须一模一样，缓存才可能命中。
      // 对不上，说明是我们这边的 prompt 在变；对得上但 read 还是 0，就是中转站没做前缀缓存。
      const shape: string[] = [];
      let acc = fp(sys);
      shape.push(`sys:${sys.length}:${acc}`);
      out.forEach((m, mi) => {
        const t = asText(m.content);
        acc = fp(`${acc}|${t}`);
        shape.push(`${m.role}${mi === markAt ? "*" : ""}:${t.length}:${acc}`);
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
        void logUsage("native", model, nd?.usage, { shape });
        const text = Array.isArray(nd?.content)
          ? nd.content
              .map((p: { type?: string; text?: string }) => (p?.type === "text" ? p.text || "" : ""))
              .join("")
          : "";
        if (text.trim()) return Response.json({ content: text });
      } else {
        const detail = await nres.text().catch(() => "");
        void logUsage("native-fail", model, { status: nres.status, detail: detail.slice(0, 300) }, { shape });
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
    ...(openaiish ? { prompt_cache_key: cacheKey } : {}),
  };

  // 三档实测：low 完全不想（写出来发笨），high 会想满额度把正文挤掉，
  // 只有 medium 稳在 2100–2500、27 秒左右、正文八百字。固定 medium。
  const geminiish = /gemini/i.test(model);

  async function call(withFormat: boolean, withEffort = geminiish) {
    const payload = {
      ...base,
      ...(withEffort ? { reasoning_effort: "medium" } : {}),
      ...(withFormat ? { response_format: { type: "json_object" } } : {}),
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
    if (!res.ok && res.status === 400 && forceJson) {
      // 有些兼容接口不认 response_format 或 reasoning_effort，两个都去掉再要一次
      res = await call(false, false);
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
    // finish 和正文长度都记下来：空回复时能分清是截断（length）还是模型自己停了
    void logUsage("compat", model, data?.usage, {
      shape: compatShape,
      key: openaiish ? cacheKey : undefined,
      finish: choice?.finish_reason,
      len: typeof content === "string" ? content.length : 0,
      // 开头一小段原文：解析不出来时能直接看出模型到底回了什么形状
      head: typeof content === "string" ? content.slice(0, 120).replace(/\s+/g, " ") : "",
      ms: Date.now() - t0,
    });
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
    return fail(timeout ? "上游三分钟没回话，再试一次。" : e instanceof Error ? e.message : "连不上模型", 502);
  }
}
