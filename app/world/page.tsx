"use client";

import Link from "next/link";
import { Fragment, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import WorldTabs from "@/components/WorldTabs";
import { getSave, getVoiceClip, getWorld, putFavorite, putSave, putVoiceClip } from "@/lib/db";
import { archiveAsk, buildMessages, characterByName, parseArchive } from "@/lib/prompt";
import { loadSettings, saveSettings, type ModelPreset } from "@/lib/settings";
import { pullJson, pullLoose, pullSegments, pullStrings } from "@/lib/json";
import {
  chapterLabel,
  chapterNo,
  chapterTitleOf,
  CHAPTER_TURNS,
  Gained,
  Message,
  newId,
  Relation,
  Save,
  Segment,
  Stage,
  turnsOf,
  World,
} from "@/lib/types";

// 自动裁剪：原文只留最近两章，更早的章只留章末档案（档案写成功才砍）。
const TRIM_CHAPTERS = true;

type ChatReply = {
  segments: Segment[];
  options: string[];
  threads?: string[];
  relations?: Relation[];
  stage?: Stage;
  aside?: string;
  gained?: Gained[];
  // 下一场的设想：走到哪、可能碰上谁。只是打算，走向变了就作废
  plan?: { scene: string; cast: string[] };
  chapter?: string;
  recap?: string;
  memo?: string;
  time?: string;
  // 壳没解析出来（被截断），调用方据此重发一次
  partial?: boolean;
};

// 关系按人成对合并：模型每回合只回变了的那几条，旧的一律留着。
// 以前是整表替换，模型一压缩就把前几章的人挤没了。
function mergeRelations(old: Relation[], delta: Relation[]): Relation[] {
  if (!delta.length) return old;
  const next = [...old];
  delta.forEach((d) => {
    const i = next.findIndex((o) => pairKey(o) === pairKey(d));
    if (i >= 0)
      next[i] = {
        ...next[i],
        level: d.level ?? next[i].level,
        state: d.state,
      };
    else next.push(d);
  });
  return next;
}

function pairKey(r: Relation) {
  return [r.a.trim(), r.b.trim()].sort().join("↔");
}

// 没兑现的事按内容合并：模型只回这一回合新埋的、变了的、兑现的。
// 兑现的那条带「✓」，按内容对上就删掉，没提到的旧条目一律留着。
// 同一件事模型常写成「（进行中）」「（遵医生医嘱）」等不同后缀，去掉括号里的状态再比。
function threadKey(t: string) {
  return t
    .replace(/^✓\s*/, "")
    .replace(/^\d+月\d+日\s*·?\s*/, "")
    .replace(/（[^）]*）/g, "")
    .replace(/\([^)]*\)/g, "")
    .replace(/[，,。；;、·\s]/g, "")
    .trim();
}

// 模型写同一件事时，前面一字不差、只在尾巴上换说法：
//「重新戴回婚戒」「出示素银戒指」「挂着颈间的素银婚戒」。
// 去掉括号后仍然不一样，按完整字符串直接比对认不出来，于是每条都留下，越攒越多。
// 按两个字一组切成片比较，改几个字也能对上。
function nearDuplicate(a: string, b: string) {
  const grams = (s: string) => {
    const set = new Set<string>();
    for (let i = 0; i < s.length - 1; i += 1) set.add(s.slice(i, i + 2));
    return set;
  };
  const A = grams(threadKey(a));
  const B = grams(threadKey(b));
  // 太短的条目不猜，免得把两件不同的小事并成一件
  if (A.size < 6 || B.size < 6) return false;
  let hit = 0;
  A.forEach((g) => {
    if (B.has(g)) hit += 1;
  });
  return hit / (A.size + B.size - hit) >= 0.72;
}

function mergeThreads(old: string[], delta: string[]): string[] {
  // 先把旧条目自己归并一次，清掉历史遗留的重复：交卷时只留最新那一句
  const list: string[] = [];
  const put = (t: string) => {
    const at = list.findIndex((x) => threadKey(x) === threadKey(t) || nearDuplicate(x, t));
    if (at >= 0) list[at] = t;
    else list.push(t);
  };
  old.forEach((t) => {
    if (t.trim()) put(t.trim());
  });
  delta.forEach((d) => {
    const t = d.trim();
    if (!t) return;
    // 兑现的那条带「✓」：按内容对上就删，对不上的也算同一件事的收尾
    if (t.startsWith("✓")) {
      const k = threadKey(t);
      for (let i = list.length - 1; i >= 0; i -= 1) {
        if (threadKey(list[i]) === k || nearDuplicate(list[i], t)) list.splice(i, 1);
      }
      return;
    }
    put(t);
  });
  return list.slice(-24);
}

function healThreads(s: Save): Save {
  if (!s.threads?.length) return s;
  const merged = mergeThreads(s.threads, []);
  return merged.length === s.threads.length ? s : { ...s, threads: merged };
}

// 章末档案统一走流式：一次等整段 JSON 回来会被网关掐成 504，
// 之前自动归档失败时是静默跳过的，于是一整章没有档案、回顾页退回去显示 200 字的简报式 recap。
async function pullArchive(
  cfg: { baseUrl: string; apiKey: string; model: string },
  messages: { role: string; content: string }[],
) {
  const res = await fetch("/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      baseUrl: cfg.baseUrl,
      apiKey: cfg.apiKey,
      model: cfg.model,
      messages,
      maxTokens: 6000,
      stream: true,
    }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw new Error(String((data as { error?: string } | null)?.error || `请求失败 ${res.status}`));
  }
  let raw = "";
  if ((res.headers.get("content-type") || "").includes("text/event-stream") && res.body) {
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() || "";
      for (const line of lines) {
        const t = line.trim();
        if (!t.startsWith("data:")) continue;
        const payload = t.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        try {
          const o = JSON.parse(payload) as { choices?: { delta?: { content?: string } }[] };
          const d = o?.choices?.[0]?.delta?.content;
          if (typeof d === "string") raw += d;
        } catch {
          /* 半截的 SSE 行跳过，下一行再来 */
        }
      }
    }
  } else {
    const data = await res.json().catch(() => null);
    raw = String((data as { content?: string } | null)?.content || "");
  }
  const parsed = parseArchive(raw);
  // 失败时把模型的原话带出来：不然拒答、截断、JSON 走形全被吞成一句「不完整」，看不出原因
  if (!parsed) throw new Error(`档案没写成：${(raw || "（空回复）").slice(0, 120)}`);
  return parsed;
}

// 旧版整表替换把前几章的关系挤掉了：各章档案里还留着，启动时把缺的人补回总表。
function healRelations(s: Save): Save {
  const known = new Set((s.relations || []).map(pairKey));
  const lost = (s.archive || [])
    .flatMap((a) => a.relations || [])
    .filter((r) => r && r.state?.trim() && !known.has(pairKey(r)));
  if (!lost.length) return s;
  return { ...s, relations: [...(s.relations || []), ...lost] };
}

// 输入框高度跟着内容走。手机上不能直接量高度为 0 的 scrollHeight：
// 那一帧布局还没更新，会拿到粘贴前的旧值，框就永远收不回去。
// 统一先置 auto，下一帧再量，超过上限才给滚动条。
function fitTextarea(el: HTMLTextAreaElement | null, max = 110) {
  if (!el) return;
  const run = () => {
    // 空的时候直接给最小高度，别让它停在上一轮的长高度
    if (!el.value) {
      el.style.height = "24px";
      el.style.overflowY = "hidden";
      return;
    }
    el.style.height = "auto";
    const h = el.scrollHeight;
    el.style.height = `${Math.max(24, Math.min(h, max))}px`;
    el.style.overflowY = h > max ? "auto" : "hidden";
  };
  run();
  requestAnimationFrame(run);
}

// 舞台只收这四个键，模型多给的字段一律不要
function toStage(v: unknown): Stage | undefined {
  if (!v || typeof v !== "object") return undefined;
  const s = v as Record<string, unknown>;
  const str = (x: unknown, n: number) => (typeof x === "string" ? x.trim().slice(0, n) : "");
  const place = str(s.place, 20);
  const weather = str(s.weather, 24);
  const look = str(s.look, 32);
  const present = Array.isArray(s.present)
    ? s.present.filter((n: unknown) => typeof n === "string" && n.trim()).map((n: string) => n.trim().slice(0, 20)).slice(0, 8)
    : [];
  if (!place && !weather && !look && !present.length) return undefined;
  return { place, weather, present, look };
}

// 空白的一小段 wav：第一次按下时先放它，把这个播放器解锁
const SILENT =
  "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAgD4AAAB9AAACABAAZGF0YQAAAAA=";

// 演出引擎能用的语气，别的方括号一律丢掉，免得念出奇怪东西
const TONES = [
  "[sighs]",
  "[whispers]",
  "[softly]",
  "[laughs]",
  "[sad]",
  "[happy]",
  "[angry]",
  "[excited]",
  "[nervous]",
  "[calm]",
  "[tired]",
  "[sarcastic]",
];

// 一段一段地认：缺字段的补默认，语气只认白名单
function toSegment(s: Segment): Segment | null {
  if (!s || typeof s.text !== "string" || !s.text.trim()) return null;
  return {
    type: s.type === "line" || s.type === "action" ? s.type : "narration",
    speaker: typeof s.speaker === "string" ? s.speaker : undefined,
    // 语气只认台词，且必须是上面那几种，模型自己编的一律丢掉
    tone:
      s.type === "line" && typeof s.tone === "string" && TONES.includes(s.tone.trim().toLowerCase())
        ? s.tone.trim().toLowerCase()
        : undefined,
    text: s.text.trim(),
    // 渠道名很短，限制长度免得模型写成长句把标题撑坏
    via:
      s.type === "line" && typeof s.via === "string" && s.via.trim()
        ? s.via.trim().slice(0, 6)
        : undefined,
    // 配音念日文时用这句；旧存档没有就退回中文
    ja:
      s.type === "line" && typeof s.ja === "string" && s.ja.trim()
        ? s.ja.trim().slice(0, 240)
        : undefined,
  };
}

function parseReply(raw: string): ChatReply {
  // 先正常解析；壳掉了（开头缺 {"segments":[）或被截断的，补一补再解析
  const data = pullJson(raw) || pullLoose(raw);
  try {
    if (!data) throw new Error("no json");
    const segments: Segment[] = (Array.isArray(data.segments) ? data.segments : [])
      .map((s) => toSegment(s as Segment))
      .filter((s): s is Segment => Boolean(s));
    const options: string[] = Array.isArray(data.options)
      ? data.options.filter((o: unknown) => typeof o === "string" && o.trim()).slice(0, 3)
      : [];
    const threads = Array.isArray(data.threads)
      ? data.threads
          .filter((t: unknown) => typeof t === "string" && t.trim())
          .map((t: string) => t.trim().slice(0, 80))
          .slice(0, 16)
      : undefined;
    const relations = Array.isArray(data.relations)
      ? data.relations
          .filter((r: Relation) => r && typeof r === "object" && (r.a || r.b) && r.state)
          .map((r: Relation) => ({
            a: String(r.a || "主角").trim().slice(0, 20),
            b: String(r.b || "？").trim().slice(0, 20),
            level:
              typeof r.level === "number" && r.level >= 0 && r.level <= 5
                ? Math.round(r.level)
                : undefined,
            state: String(r.state || "").trim().slice(0, 60),
          }))
          .filter((r: Relation) => r.state)
          .slice(0, 12)
      : undefined;
    const chapter = typeof data.chapter === "string" ? data.chapter.trim().slice(0, 16) : "";
    const recap = typeof data.recap === "string" ? data.recap.trim().slice(0, 400) : "";
    const memo = typeof data.memo === "string" ? data.memo.trim().slice(0, 200) : "";
    const time = typeof data.time === "string" ? data.time.trim().slice(0, 40) : "";
    const stage = toStage(data.stage);
    const aside = typeof data.aside === "string" ? data.aside.trim().slice(0, 80) : "";
    const gained: Gained[] = Array.isArray(data.gained)
      ? data.gained
          .filter((g: unknown) => g && typeof g === "object")
          .map((g: { name?: unknown; note?: unknown }) => ({
            name: typeof g.name === "string" ? g.name.trim().slice(0, 16) : "",
            note: typeof g.note === "string" ? g.note.trim().slice(0, 24) : undefined,
          }))
          .filter((g: Gained) => g.name)
          .slice(0, 3)
      : [];
    // 设想可能没给、也可能写坏，缺了就当没有，不影响这一回合
    const rawPlan = data.plan && typeof data.plan === "object" ? (data.plan as { scene?: unknown; cast?: unknown }) : null;
    const scene = rawPlan && typeof rawPlan.scene === "string" ? rawPlan.scene.trim().slice(0, 60) : "";
    const cast = rawPlan && Array.isArray(rawPlan.cast)
      ? rawPlan.cast
          .filter((n: unknown) => typeof n === "string" && n.trim())
          .map((n: string) => n.trim().slice(0, 20))
          .slice(0, 2)
      : [];
    const plan = scene || cast.length ? { scene, cast } : undefined;
    if (segments.length)
      return { segments, options, threads, relations, stage, aside, gained, plan, chapter, recap, memo, time };
  } catch {
    // 模型没按 JSON 回，往下逐段捞
  }
  // 壳都补不回来：把写完的段落一段段捞出来，这一回合照样能读，不用花钱重写
  const salvaged = pullSegments(raw)
    .map((s) => toSegment(s as Segment))
    .filter((s): s is Segment => Boolean(s));
  // partial 说明壳是坏的：多半写到一半被截了，调用方要重发一次
  if (salvaged.length) return { segments: salvaged, options: pullStrings(raw, "options"), partial: true };
  return { segments: [{ type: "narration", text: raw.trim() }], options: [], partial: true };
}

// 早前解析失败时整段 JSON 被当成旁白存进了存档，这里就地把写完的段落救出来
function rescueSave(s: Save): Save {
  let changed = false;
  const messages = s.messages.map((m) => {
    if (m.role !== "assistant") return m;
    const segs = m.segments || [];
    if (segs.length !== 1 || segs[0].type !== "narration") return m;
    const t = (segs[0].text || "").trim();
    if (!t.startsWith("{")) return m;
    const r = parseReply(t);
    if (r.segments.length === 1 && r.segments[0].text.trim() === t) return m;
    changed = true;
    return {
      ...m,
      text: r.segments.map((x) => x.text).join("\n"),
      segments: r.segments,
      options: r.options,
    };
  });
  return changed ? { ...s, messages } : s;
}

export default function PlayPage() {
  // 静态导出没有动态路由，世界 id 改从查询串读；useSearchParams 必须包在 Suspense 里
  return (
    <Suspense
      fallback={
        <main className="page">
          <div className="loading">正在翻开</div>
        </main>
      }
    >
      <Play />
    </Suspense>
  );
}

function Play() {
  const search = useSearchParams();
  const worldId = search.get("id") || "";
  const [world, setWorld] = useState<World | null>(null);
  const [save, setSave] = useState<Save | null>(null);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState("");
  const [seed, setSeed] = useState("");
  // 序章：第一幕的背景，只在开场用一次，可以写很长
  const [prologue, setPrologue] = useState("");
  // 重写前可以先写一句：这回合哪里不对、要怎么改。只作用于这一次重写。
  const [regenOpen, setRegenOpen] = useState(false);
  const [regenNote, setRegenNote] = useState("");
  // 原本发出去的那句，重写时也能改：打错意思、说偏了，回到这一刻重说。
  const [regenText, setRegenText] = useState("");
  const [busy, setBusy] = useState(false);
  // 正文用哪套配置：设置页存下的预设，这里一键切，不必回去重填地址和 Key
  const [presets, setPresets] = useState<ModelPreset[]>([]);
  const [modelNow, setModelNow] = useState("");
  const [modelOpen, setModelOpen] = useState(false);
  const modelRef = useRef<HTMLDivElement>(null);
  // 三个选项照常让模型吐，只是想看剧情时可以收起来；这个偏好记在本机
  const [hideOptions, setHideOptions] = useState(false);
  const [error, setError] = useState("");
  const [toast, setToast] = useState("");
  const [playing, setPlaying] = useState<string | null>(null);
  const storyRef = useRef<HTMLDivElement>(null);
  // 输入框自己按内容长高；高度统一由 draft/seed 变化来算，
  // 不然发送后清空、点选项填字时高度对不上，框就会忽大忽小
  const draftRef = useRef<HTMLTextAreaElement>(null);
  const seedRef = useRef<HTMLTextAreaElement>(null);
  // 序章要能写很长，别让框停在几行
  const prologueRef = useRef<HTMLTextAreaElement>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  // 这一页里已经拿到的音频地址：同一句再点直接播，不用再读库
  const urlCache = useRef<Map<string, string>>(new Map());
  // 连点几句时，只让最后点的那句出声
  const playSeq = useRef(0);
  // 播放器有没有被手指解锁过（解锁前 await 回来再 play 会被拦）
  const unlocked = useRef(false);

  useEffect(
    () => () => {
      audioRef.current?.pause();
      urlCache.current.forEach((u) => URL.revokeObjectURL(u));
      urlCache.current.clear();
    },
    [],
  );

  useEffect(() => {
    setHideOptions(localStorage.getItem("wenyou.hideOptions") === "1");
  }, []);

  // 打开页面、以及回设置页改完之后，把当前配置和预设重新读一遍
  useEffect(() => {
    const read = () => {
      const st = loadSettings();
      setPresets(st.presets || []);
      setModelNow(st.text.model);
    };
    read();
    window.addEventListener("wenyou:settings", read);
    return () => window.removeEventListener("wenyou:settings", read);
  }, []);

  // 切预设：地址、模型、Key 一起换，下一回合出字就用新的
  function applyPreset(p: ModelPreset) {
    const st = loadSettings();
    saveSettings({
      ...st,
      text: { ...st.text, baseUrl: p.baseUrl, model: p.model, apiKey: p.apiKey },
    });
    setModelNow(p.model);
    setModelOpen(false);
    setToast(`换到 ${p.name}`);
    window.setTimeout(() => setToast(""), 1800);
  }

  // 点到别处就把列表收起来，别一直挂在那儿挡着正文
  useEffect(() => {
    if (!modelOpen) return;
    const away = (e: MouseEvent) => {
      if (!modelRef.current?.contains(e.target as Node)) setModelOpen(false);
    };
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, [modelOpen]);

  function toggleOptions() {
    const next = !hideOptions;
    setHideOptions(next);
    localStorage.setItem("wenyou.hideOptions", next ? "1" : "0");
  }

  // 点选项时光标不能丢：手机上了一点就收键盘，位置一变点击就落空了。
  // 保持输入框聚焦，并把光标放到末尾，选完还能接着打字。
  function focusDraftEnd() {
    requestAnimationFrame(() => {
      const el = draftRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    });
  }

  // 高度只跟内容走：发送清空、点选项填进来，都会在这里重算一次
  useEffect(() => {
    fitTextarea(seedRef.current);
  }, [seed]);

  // 发送后、切回前台、转屏，都重新量一次：iOS 上键盘收起时高度会算错
  useEffect(() => {
    fitTextarea(draftRef.current);
  }, [draft, busy]);

  useEffect(() => {
    const onResize = () => fitTextarea(draftRef.current);
    window.addEventListener("resize", onResize);
    window.addEventListener("orientationchange", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      window.removeEventListener("orientationchange", onResize);
    };
  }, []);

  useEffect(() => {
    if (prologueRef.current) fitTextarea(prologueRef.current, 220);
  }, [prologue]);

  useEffect(() => {
    (async () => {
      const w = await getWorld(worldId);
      if (!w) {
        setLoading(false);
        return;
      }
      const s = await getSave(worldId);
      const fixed = s ? healThreads(healRelations(rescueSave(s))) : s;
      setWorld(w);
      setSave(fixed);
      if (fixed?.seed) setSeed(fixed.seed);
      if (fixed?.prologue) setPrologue(fixed.prologue);
      setLoading(false);
      if (fixed && fixed !== s) await putSave(fixed);
    })();
  }, [worldId]);

  const turns = save ? turnsOf(save) : 0;
  const hasMessages = Boolean(save && save.messages.length);
  const lastAssistant = useMemo(() => {
    if (!save) return undefined;
    for (let i = save.messages.length - 1; i >= 0; i--) {
      if (save.messages[i].role === "assistant") return save.messages[i];
    }
    return undefined;
  }, [save]);

  useEffect(() => {
    const el = storyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [save, busy]);

  function chapterTranscript(messages: Message[], idx: number, base = 0) {
    // 早前的章整章砍掉过，回合数要从被砍的地方接着数，不然章号会往前错位
    let turn = base;
    const out: string[] = [];
    messages.forEach((m) => {
      if (m.role === "user") turn += 1;
      const at = Math.ceil(Math.max(turn, 1) / CHAPTER_TURNS) - 1;
      if (at !== idx) return;
      if (m.role === "user") {
        out.push(`玩家：${m.text}`);
      } else {
        const body = (m.segments || [])
          .map((s) => (s.type === "line" ? `${s.speaker || "某人"}${s.via ? `（${s.via}）` : ""}：「${s.text}」` : s.text))
          .join("\n");
        if (body.trim()) out.push(body);
      }
    });
    return out.join("\n\n");
  }

  async function buildArchive(base: Save, idx: number) {
    if (!world) return;
    const cfg = loadSettings().assistant;
    if (!cfg.apiKey.trim()) return;
    const transcript = chapterTranscript(base.messages, idx, base.droppedTurns || 0);
    if (!transcript.trim()) return;
    try {
      // 中转偶尔抽风（504、429、JSON 截断），自动归档也连试两次，别静默丢掉一整章
      let entry: ReturnType<typeof parseArchive> = null;
      for (let attempt = 1; attempt <= 2 && !entry; attempt += 1) {
        try {
          entry = await pullArchive(cfg, archiveAsk(world, idx + 1, transcript, base.clocks?.[idx]));
        } catch (err) {
          // 自动归档失败不拦正片，但要在控制台留下原因，方便判断是被审核挡了还是请求挂了
          if (attempt === 2) {
            console.warn("[档案] 第", idx + 1, "章写失败：", (err as Error).message);
            return;
          }
        }
      }
      if (!entry) return;
      const cur = (await getSave(worldId)) || base;
      const archive = [...(cur.archive || [])];
      archive[idx] = entry;
      const chapterTitles = [...(cur.chapterTitles || [])];
      if (!chapterTitles[idx]?.trim() && entry.title) chapterTitles[idx] = entry.title;
      const recaps = [...(cur.recaps || [])];
      if (!recaps[idx]?.trim()) recaps[idx] = entry.state || entry.summary;
      const next: Save = { ...cur, archive, chapterTitles, recaps, updatedAt: Date.now() };
      await putSave(next);
      setSave((prev) => (prev ? { ...prev, archive, chapterTitles, recaps } : prev));
    } catch {
      /* 档案失败不影响正片，下一章还有 recap 兜着 */
    }
  }

  // 整章砍掉：只留最近两章原文，更早的章靠档案活。
  // 档案写成了就用档案；档案没写成（总结接口失败）但有 chapter recap 的，也照样砍，
  // 否则旧存档会一直不砍、历史无限变长——recap 里至少有这一章停在哪。
  function trimChapters(s: Save): Save {
    if (!TRIM_CHAPTERS) return s;
    const done = Math.floor(turnsOf(s) / CHAPTER_TURNS);
    const target = Math.max(0, (done - 1) * CHAPTER_TURNS);
    if (target <= (s.droppedTurns || 0)) return s;
    let keepFrom = target;
    for (let c = Math.floor((s.droppedTurns || 0) / CHAPTER_TURNS); c < target / CHAPTER_TURNS; c++) {
      const a = s.archive?.[c];
      const archived = Boolean(a && (a.state || a.summary || a.events?.length));
      const recap = Boolean(s.recaps?.[c]?.trim());
      if (!archived && !recap) {
        keepFrom = c * CHAPTER_TURNS;
        break;
      }
    }
    if (keepFrom <= (s.droppedTurns || 0)) return s;
    let turn = s.droppedTurns || 0;
    let dropping = true;
    const messages: Message[] = [];
    // 砍掉的原文不删，按章收进 buried：回顾页还能看，但 buildMessages 只读 messages，不会再喂给模型
    const buried = (s.buried || []).slice();
    for (const m of s.messages) {
      if (m.role === "user") {
        turn += 1;
        if (turn > keepFrom) dropping = false;
      }
      if (!dropping) {
        messages.push(m);
      } else {
        const ch = Math.ceil(Math.max(turn, 1) / CHAPTER_TURNS) - 1;
        if (!buried[ch]) buried[ch] = [];
        buried[ch].push(m);
      }
    }
    if (messages.length === s.messages.length) return s;
    return { ...s, messages, buried, droppedTurns: keepFrom };
  }

  async function generate(nextSave: Save, opening?: string, extra?: string) {
    // 设定页改完马上回来，页面里的 world 可能还是上一次加载的那份，
    // 每次出字前重读一遍，新加的设定、人物、世界书才能进提示词。
    const w = (await getWorld(worldId)) || world;
    if (!w) return;
    if (w !== world) setWorld(w);
    const settings = loadSettings();
    if (!settings.text.apiKey.trim()) {
      setError("还没有填文本 Key。去设置里填一个。");
      setBusy(false);
      return;
    }
    setBusy(true);
    setError("");
    try {
      // 上一章已经收尾、档案也写成了：这时候才把更早那一章的原文砍掉。
      // 砍在前一回合做，这一回合发给模型的就是短历史，前缀缓存从这一刻重建一次。
      const trimmed = trimChapters(nextSave);
      if (trimmed !== nextSave) {
        nextSave = trimmed;
        setSave(trimmed);
        await putSave(trimmed);
      }
      const turns = turnsOf(nextSave);
      // 序章粘进来就是第一回合的正文，不再让模型重写一遍场面
      const prologueScene = turns === 0 ? (nextSave.prologue || "").trim() : "";
      const nameAt = chapterNo(nextSave) - 1;
      const closeAt = Math.max(0, Math.ceil(turns / CHAPTER_TURNS) - 1);
      const nameChapter =
        (turns === 0 || (turns - 1) % CHAPTER_TURNS === 0) && !chapterTitleOf(nextSave, nameAt + 1);
      const closeChapter = turns > 0 && turns % CHAPTER_TURNS === 0 && !nextSave.recaps?.[closeAt];
      const memoAt = turns > 0 && turns % 8 === 0 && turns % CHAPTER_TURNS !== 0;
      // 一回合最多试两次：中转偶尔把请求当成异步任务，只回一句占位（task ready），
      // 或者正文写到一半被截断。这两种都不算演出，重发一次通常就正常。
      let reply: ChatReply | null = null;
      for (let attempt = 0; attempt < 2 && !reply; attempt += 1) {
        if (attempt) await new Promise((r) => setTimeout(r, 800));
        const res = await fetch("/api/chat", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            baseUrl: settings.text.baseUrl,
            apiKey: settings.text.apiKey,
            model: settings.text.model,
            messages: buildMessages(w, nextSave, opening, {
              nameChapter,
              closeChapter,
              memo: memoAt,
              extra,
              ja: settings.voice.lang === "ja",
              prologueScene: !!prologueScene,
            }),
            // 1600 是实测唯一能把思考压在两千以内的额度：这个中转把思考也算进输出额度，
            // 额度给多大它就想多久（tiered 两次都是想到快满才停，正文被截断），所以不放开。
            maxTokens: 1600,
          }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data?.error || "请求失败");
        const got = parseReply(String(data.content || ""));
        const words = got.segments.map((s) => s.text).join("").trim();
        // 一句占位语（不足四十个字、又没有连续中文）也不算写出来
        const broken =
          !got.segments.length || got.partial || (words.length < 40 && !/[\u4e00-\u9fa5]{6}/.test(words));
        if (!broken) reply = got;
      }
      // 两次都没写出来：不要存一条空回复，直接把错误摆出来让玩家再发
      if (!reply) throw new Error("这次模型没写出正文，再发一次。");
      // 设想里只留设定表上真有的人名，模型乱编的名字直接丢掉
      const roster = new Set(w.characters.map((c) => c.name.trim()));
      const plan = reply.plan
        ? { scene: reply.plan.scene, cast: reply.plan.cast.filter((n) => roster.has(n)) }
        : undefined;
      const msg: Message = {
        id: newId(),
        role: "assistant",
        text: reply.segments.map((s) => s.text).join("\n"),
        segments: reply.segments,
        options: reply.options,
        stage: reply.stage,
        aside: reply.aside,
        gained: reply.gained,
        plan,
        at: Date.now(),
      };
      const chapterTitles = [...(nextSave.chapterTitles || [])];
      if (reply.chapter && nameChapter) chapterTitles[nameAt] = reply.chapter;
      const recaps = [...(nextSave.recaps || [])];
      if (reply.recap && closeChapter) recaps[closeAt] = reply.recap;
      // 每章第一回合的时间记下来：章末档案写日期区间要用它当起点，
      // 不然只知道这一章结束在哪天，不知道从哪天开始。
      const clocks = [...(nextSave.clocks || [])];
      if (!clocks[nameAt]?.trim()) {
        const at = (reply.time || nextSave.clock || "").trim();
        if (at) clocks[nameAt] = at;
      }
      const updated: Save = {
        ...nextSave,
        messages: [...nextSave.messages, msg],
        chapterTitles,
        recaps,
        clocks,
        memo: reply.memo && memoAt ? reply.memo : nextSave.memo,
        // 时间只往前走，模型没给就沿用上一回合
        clock: reply.time || nextSave.clock,
        // 舞台同理：没给说明没变
        stage: reply.stage || nextSave.stage,
        // 没兑现的事按内容增量合并：模型只回变化，旧的留着，带「✓」的删掉
        threads: reply.threads ? mergeThreads(nextSave.threads || [], reply.threads) : nextSave.threads,
        // 关系是总表：模型只给变化，按人成对合并，旧的留着
        relations: reply.relations ? mergeRelations(nextSave.relations || [], reply.relations) : nextSave.relations,
      };
      setSave(updated);
      await putSave(updated);
      if (closeChapter) void buildArchive(updated, closeAt);
    } catch (e) {
      setError(e instanceof Error ? e.message : "生成失败，再试一次。");
    } finally {
      setBusy(false);
    }
  }

  async function send() {
    const text = draft.trim();
    if (!text || busy || !save) return;
    setDraft("");
    const msg: Message = { id: newId(), role: "user", text, at: Date.now() };
    const next: Save = { ...save, messages: [...save.messages, msg] };
    setSave(next);
    await putSave(next);
    setPlaying(null);
    await generate(next);
  }

  async function start() {
    if (!save || busy) return;
    const opening = seed.trim();
    // 把开场那句、序章都存进存档：重写第一回合时还得用，重新进页面也还在
    const base: Save = { ...save, seed: opening, prologue: prologue.trim() };
    setSave(base);
    await putSave(base);
    await generate(base, opening);
  }

  // 把最后一条回复作废，拿同样的前文再要一次
  // note 是这一次重写的额外要求，只在本次请求里用，不写进存档
  async function regenerate(note?: string, rewrite?: string) {
    if (!save || busy) return;
    const msgs = [...save.messages];
    while (msgs.length && msgs[msgs.length - 1].role === "assistant") msgs.pop();
    // 改过原话就换掉最后一条玩家消息的文字；存档里也存改后的版本，
    // 不然下一回合读到的是旧措辞，前后会对不上。
    const fixed = (rewrite || "").trim();
    const last = msgs[msgs.length - 1];
    if (fixed && last?.role === "user" && fixed !== last.text) msgs[msgs.length - 1] = { ...last, text: fixed };
    // 退回开场：档案、关系、伏笔也跟着归零，别把不要的那一版记下来
    const base: Save = msgs.length
      ? { ...save, messages: msgs }
      : {
          ...save,
          messages: [],
          chapterTitles: [],
          recaps: [],
          archive: [],
          threads: [],
          relations: [],
          clocks: [],
          droppedTurns: 0,
          memo: "",
          clock: "",
        };
    setSave(base);
    await putSave(base);
    setPlaying(null);
    await generate(base, (save.seed || seed).trim(), note);
  }

  // 长按播放键 = 收藏这句。按下开始计时，松手、滑走、被打断都取消。
  const longPressed = useRef(false);
  const pressTimer = useRef<number | null>(null);

  // 合成一句：先吃内存和本机的语音缓存，没有再花额度。
  // 播放和收藏都走这里，保证收藏拿到的和听到的是同一份音频。
  async function syncClip(seg: Segment, segs: Segment[], idx: number) {
    if (!world) throw new Error("这个世界不在了。");
    const settings = loadSettings();
    if (!settings.voice.apiKey.trim()) throw new Error("还没有填语音 Key。去设置里填一个。");
    const character = characterByName(world, seg.speaker);
    const voiceId = character?.voiceId?.trim() || settings.voice.defaultVoiceId;
    // 语气标记（[sighs] 之类）v3 起才认，v2/turbo/flash 会把方括号当字念出来
    // 只用这句自己带的标记；设置里那个只用来试听，不能套到每一句上
    const v3 = /v[3-9]/i.test(settings.voice.model);
    const tone = v3 ? (seg.tone || "").trim() : "";
    // 配音语言选日文就念 ja，正文照旧显示中文；旧存档没给 ja 就退回原句
    const spoken = (x?: Segment) =>
      (settings.voice.lang === "ja" ? x?.ja?.trim() || "" : "") || x?.text || "";
    const line = spoken(seg);
    const say = tone ? `${tone} ${line}` : line;
    // 单句合成容易被念平，把前一句递过去做上下文就够了。
    // 下一句不再递：v3/v4 会顺着 next_text 往下念，偶尔把下一段的台词一起念出来。
    const prev = v3 && idx > 0 ? spoken(segs[idx - 1]).slice(-160) : "";
    // 合成参数一样、文字一样、上下文一样，就复用同一份音频。
    // next 不再参与缓存键，旧的（可能多念了下一句的）音频会自然失效、重新合成一次。
    const clipKey = [voiceId, settings.voice.model, settings.voice.speed ?? "", prev, say].join("|");
    const known = urlCache.current.get(clipKey);
    if (known) {
      const blob = await getVoiceClip(clipKey).catch(() => undefined);
      if (blob) return { url: known, blob, clipKey };
    }
    const cached = await getVoiceClip(clipKey).catch(() => undefined);
    if (cached) {
      const url = URL.createObjectURL(cached);
      urlCache.current.set(clipKey, url);
      return { url, blob: cached, clipKey };
    }
    const res = await fetch("/api/voice", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        apiKey: settings.voice.apiKey,
        voiceId,
        text: say,
        model: settings.voice.model,
        speed: settings.voice.speed,
        previousText: prev,
      }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => null);
      throw new Error(data?.error || "语音没出来");
    }
    const blob = await res.blob();
    // 合成一次就存本地，往后这句不再花额度
    void putVoiceClip(clipKey, blob).catch(() => {});
    const url = URL.createObjectURL(blob);
    urlCache.current.set(clipKey, url);
    return { url, blob, clipKey };
  }

  // 收藏：音频和文字一起进本机，语音缓存到期也不会跟着消失
  async function favorite(seg: Segment, segs: Segment[], idx: number) {
    const { blob, clipKey } = await syncClip(seg, segs, idx);
    await putFavorite({
      key: `${world?.id || ""}-${clipKey}`,
      worldId: world?.id || "",
      worldTitle: world?.title || "",
      speaker: seg.speaker || "",
      text: seg.text || "",
      blob,
      at: Date.now(),
    });
    setToast(seg.speaker ? `已收藏 ${seg.speaker} 这句` : "已收藏这句");
    window.setTimeout(() => setToast(""), 1800);
  }

  function pressStart(seg: Segment, segs: Segment[], idx: number, key: string) {
    longPressed.current = false;
    if (pressTimer.current) window.clearTimeout(pressTimer.current);
    pressTimer.current = window.setTimeout(() => {
      pressTimer.current = null;
      longPressed.current = true;
      if (playing === key) {
        audioRef.current?.pause();
        setPlaying(null);
      }
      setToast("正在收藏…");
      void favorite(seg, segs, idx).catch((e) => {
        setToast("");
        setError(e instanceof Error ? e.message : "收藏失败");
      });
    }, 520);
  }

  function pressEnd() {
    if (pressTimer.current) {
      window.clearTimeout(pressTimer.current);
      pressTimer.current = null;
    }
    // 长按之后如果没触发 click（手指滑出去了），过一会儿把标记清掉，
    // 免得下一次正常的点击被吞掉
    if (longPressed.current) {
      window.setTimeout(() => {
        longPressed.current = false;
      }, 400);
    }
  }

  async function play(seg: Segment, key: string, segs: Segment[] = [], idx = -1) {
    // 刚长按过：这一下是收藏，不要再放一遍
    if (longPressed.current) {
      longPressed.current = false;
      return;
    }
    if (!world) return;
    // 手指按下的这一刻是唯一能解锁音频的时机，后面的 await 一过浏览器就不认了。
    // 所以整页只用一个播放器，第一次按下先放一段静音把它解锁。
    const el = audioRef.current ?? (audioRef.current = new Audio());
    el.volume = 1;
    el.preload = "auto";
    if (!unlocked.current) {
      unlocked.current = true;
      el.src = SILENT;
      void el.play().catch(() => {});
    }
    if (playing === key) {
      el.pause();
      setPlaying(null);
      return;
    }
    const seq = ++playSeq.current;
    setError("");
    setPlaying(key);
    try {
      const { url } = await syncClip(seg, segs, idx);
      if (seq !== playSeq.current) return;
      el.pause();
      el.src = url;
      const clear = () => setPlaying((p) => (p === key ? null : p));
      el.onended = clear;
      el.onerror = () => {
        clear();
        setError("这句音频放不出来，再点一次试试。");
      };
      try {
        await el.play();
      } catch {
        clear();
        setError("系统把声音挡住了，再点一次。");
      }
    } catch (e) {
      if (seq !== playSeq.current) return;
      setPlaying(null);
      setError(e instanceof Error ? e.message : "语音失败");
    }
  }

  if (loading) {
    return (
      <main className="page">
        <div className="loading">正在翻开</div>
      </main>
    );
  }

  if (!world || !save) {
    return (
      <main className="page">
        <div className="topbar">
          <Link className="where" href="/">
            <u>‹</u>我的世界
          </Link>
        </div>
        <p className="emptyhint">这个世界不在了。</p>
      </main>
    );
  }

  // 这一回合玩家原本发出去的那句话：重写时填进输入框，方便直接改
  const lastUserText = [...save.messages].reverse().find((m) => m.role === "user")?.text || "";

  return (
    <main className="page fill">
      <WorldTabs worldId={world.id} title={world.title} active="play" />

      <div className="chap">
        <b>{chapterLabel(save)}</b>
        <span className="n">
          {turns} 回合 · 本章 {turns === 0 ? 0 : ((turns - 1) % CHAPTER_TURNS) + 1}/{CHAPTER_TURNS}
        </span>
        {hasMessages && (
          <button
            type="button"
            className="regen"
            onClick={() => {
              const next = !regenOpen;
              setRegenOpen(next);
              if (next) {
                setRegenText(lastUserText);
                setRegenNote("");
              }
            }}
            disabled={busy}
          >
            ↻ 重写这一回合
          </button>
        )}
        <Link href={`/world/recap/?id=${world.id}`}>回顾 ›</Link>
      </div>
      {presets.length > 0 && (
        <div className="mpick" ref={modelRef}>
          <button type="button" className="mtag" onClick={() => setModelOpen(!modelOpen)}>
            模型：{presets.find((p) => p.model === modelNow)?.name || modelNow || "未设"} ▾
          </button>
          {modelOpen && (
            <div className="mpop">
              {presets.map((p) => (
                <button
                  type="button"
                  key={p.id}
                  className={p.model === modelNow ? "on" : ""}
                  onClick={() => applyPreset(p)}
                  title={`${p.baseUrl}｜${p.model}`}
                >
                  <b>{p.name}</b>
                  <em>{p.model}</em>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
      {regenOpen && hasMessages && (
        <div className="regenbox">
          <label className="regenfield">
            <span className="regenlab">我原本说的（可以直接改）</span>
            <textarea
              value={regenText}
              onChange={(e) => setRegenText(e.target.value)}
              placeholder="留空就按原样"
              rows={3}
            />
          </label>
          <label className="regenfield">
            <span className="regenlab">这次想怎么改</span>
            <textarea
              value={regenNote}
              onChange={(e) => setRegenNote(e.target.value)}
              placeholder="比如：丹恒听见了就好，别让他走回来再说话。"
              rows={2}
            />
          </label>
          <div className="regenrow">
            <span>两个都留空就照原样重来</span>
            <button
              type="button"
              onClick={() => {
                setRegenOpen(false);
                setRegenNote("");
                setRegenText("");
              }}
            >
              取消
            </button>
            <button
              type="button"
              className="go"
              disabled={busy}
              onClick={() => {
                setRegenOpen(false);
                void regenerate(regenNote, regenText);
              }}
            >
              重写
            </button>
          </div>
        </div>
      )}
      {save.clock || save.stage ? (
        <div className="nowbar">
          <div className="nowmain">
            {save.clock ? <span className="nowtime">{save.clock}</span> : null}
            {save.stage?.place ? <span className="nowplace">{save.stage.place}</span> : null}
            {save.stage?.weather ? <span className="nowweather">{save.stage.weather}</span> : null}
          </div>
          {save.stage?.present?.length || save.stage?.look ? (
            <div className="nowsub">
              {save.stage?.present?.length ? <span>在场 {save.stage.present.join(" · ")}</span> : null}
              {save.stage?.look ? <span>{save.stage.look}</span> : null}
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="story" ref={storyRef}>
        {!hasMessages && (
          <div className="first">
            {world.summary || "这个世界还没有写下第一句。"}
            <br />
            你站在门口。按下开始，让里面的人先动起来。
          </div>
        )}

        {save.messages.map((m, mi) =>
          m.role === "user" ? (
            <div className="blk you" key={m.id}>
              <span className="you-label">你</span>
              <div className="act">{m.text}</div>
            </div>
          ) : (
            <Fragment key={m.id}>
              {(m.segments || []).map((seg, i) => {
              const key = `${m.id}-${i}`;
              if (seg.type === "line" && seg.speaker) {
                const c = characterByName(world, seg.speaker);
                return (
                  <div className={seg.via ? "blk say msg" : "blk say"} key={key}>
                    <div className="sayer">
                      <span className="face">
                        {c?.avatar ? <img src={c.avatar} alt="" /> : (seg.speaker || "？").slice(0, 1)}
                      </span>
                      {seg.via ? <span className="via">{seg.via}</span> : null}
                      <span className="who">{seg.speaker || "某人"}</span>
                      <button
                        type="button"
                        className={playing === key ? "playbtn on" : "playbtn"}
                        onClick={() => play(seg, key, m.segments || [], i)}
                        onPointerDown={() => pressStart(seg, m.segments || [], i, key)}
                        onPointerUp={pressEnd}
                        onPointerLeave={pressEnd}
                        onPointerCancel={pressEnd}
                        onContextMenu={(e) => e.preventDefault()}
                        aria-label={playing === key ? "停止" : "念这句，长按收藏"}
                      >
                        <svg viewBox="0 0 12 12" width="9" height="9" aria-hidden="true">
                          {playing === key ? (
                            <>
                              <rect x="3" y="2.4" width="1.7" height="7.2" rx=".6" fill="currentColor" />
                              <rect x="7.3" y="2.4" width="1.7" height="7.2" rx=".6" fill="currentColor" />
                            </>
                          ) : (
                            <path d="M4.2 2.5 9.4 6l-5.2 3.5Z" fill="currentColor" />
                          )}
                        </svg>
                      </button>
                    </div>
                    <p>{seg.text}</p>
                  </div>
                );
              }
              if (seg.type === "action") {
                return (
                  <div className="blk act" key={key}>
                    {seg.text}
                  </div>
                );
              }
              return (
                <div className="blk narr" key={key}>
                  {seg.text}
                </div>
              );
              })}
              {m.aside ? <div className="aside">{m.aside}</div> : null}
              {(() => {
                // 模型爱把以前给过的东西再报一遍，只显示这回合新到手的那几件
                const before = new Set<string>();
                save.messages.slice(0, mi).forEach((x) => (x.gained || []).forEach((g) => before.add(g.name)));
                const fresh = (m.gained || []).filter((g) => !before.has(g.name));
                return fresh.length ? (
                  <div className="loot">
                    {fresh.map((g, i) => (
                      <span className="lootitem" key={`${m.id}-g${i}`}>
                        <b>{g.name}</b>
                        {g.note ? <em>{g.note}</em> : null}
                      </span>
                    ))}
                  </div>
                ) : null;
              })()}
            </Fragment>
          ),
        )}

        {busy && <div className="waiting">正在发生</div>}
      </div>

      <div className="composer">
        {!busy && !hideOptions && lastAssistant?.options?.length ? (
          <div className="chips">
            {lastAssistant.options.map((o, i) => (
              <div className="chiprow" key={o + i}>
                <button
                  type="button"
                  className="chip"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    setDraft(o);
                    focusDraftEnd();
                  }}
                >
                  <em>{["一", "二", "三"][i] || i + 1}</em>
                  {o}
                </button>
                {draft.trim() ? (
                  <button
                    type="button"
                    className="chipadd"
                    aria-label="追加这个选项"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => {
                      setDraft((d) => (d.trim() ? `${d.replace(/\s+$/, "")}\n${o}` : o));
                      focusDraftEnd();
                    }}
                  >
                    ＋
                  </button>
                ) : null}
              </div>
            ))}
          </div>
        ) : null}

        {!hasMessages && !busy ? (
          <div className="seed">
            <textarea
              ref={prologueRef}
              rows={5}
              className="prologue"
              value={prologue}
              placeholder="序章（可留空）：粘进来就是第一回合的内容——交代的写成旁白、动过的写成动作、说过的写成台词，停在最后一句，不往前推。"
              onChange={(e) => setPrologue(e.target.value)}
              onInput={(e) => fitTextarea(e.currentTarget, 220)}
              onPaste={() => fitTextarea(prologueRef.current, 220)}
            />
            <textarea
              ref={seedRef}
              rows={2}
              value={seed}
              placeholder="想从哪儿开始？带上时间更好，比如：九月一日，周一早上七点，我在教室醒来。（可留空）"
              onChange={(e) => setSeed(e.target.value)}
              onInput={(e) => fitTextarea(e.currentTarget)}
              onPaste={() => fitTextarea(seedRef.current)}
            />
            <button type="button" className="btn" onClick={start}>
              让世界开始
            </button>
          </div>
        ) : (
          <div className="inputbar">
            <textarea
              ref={draftRef}
              rows={1}
              value={draft}
              placeholder="写一句你想做的…"
              onChange={(e) => setDraft(e.target.value)}
              onInput={(e) => fitTextarea(e.currentTarget)}
              onPaste={() => fitTextarea(draftRef.current)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  send();
                }
              }}
            />
            <button
              type="button"
              className="send"
              disabled={!draft.trim() || busy}
              onClick={send}
              aria-label="发送"
            >
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" aria-hidden="true">
                <path d="M12 19.5V5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                <path
                  d="M5.6 11.2 12 4.8l6.4 6.4"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
          </div>
        )}

        {toast ? <div className="toast">{toast}</div> : null}

        {error ? (
          <div className="hint">
            <Link href="/settings/">{error}</Link>
          </div>
        ) : !busy && lastAssistant?.options?.length ? (
          <div className="hint">
            <span>{hideOptions ? "选项已收起" : "点选项替换，点右侧＋叠加，不直接发"}</span>
            <button type="button" className="hintbtn" onClick={toggleOptions}>
              {hideOptions ? "展开" : "收起"}
            </button>
          </div>
        ) : (
          <div className="hint">点选项替换，点右侧＋叠加，不直接发</div>
        )}
      </div>
    </main>
  );
}
