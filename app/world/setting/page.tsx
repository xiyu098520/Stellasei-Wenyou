"use client";

import Link from "next/link";
import { Fragment, Suspense, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import WorldTabs from "@/components/WorldTabs";
import { getWorld, putWorld } from "@/lib/db";
import { loadSettings } from "@/lib/settings";
import { assistantSystem, netSystem } from "@/lib/prompt";
import { pullJson, pullSay } from "@/lib/json";
import { Block, newId, Note, World } from "@/lib/types";

type AiWrite =
  | { type: "block"; block: string; text: string; mode?: "append" | "replace" }
  | { type: "protagonist"; text: string; mode?: "append" | "replace" }
  | { type: "character"; name: string; identity: string; speech: string; fields: { k: string; v: string }[] };

// 模型有时会把「我」当成普通块写，落到别的栏目里，这里兜一层
const ME_NAMES = ["我", "主角", "我的设定", "主角设定", "我的人设", "玩家"];

// 旧会话里可能存着整段 JSON，发给模型前先还原成正常的话
function tidyHistory(text: string) {
  const s = text.trim();
  if (!s.startsWith("{")) return text;
  const j = pullJson(s);
  if (j && typeof j.say === "string" && j.say.trim()) return j.say.trim();
  return pullSay(s) || text;
}

// 现在模型会先给一行 JSON 头，再给 --- 和正文；正文是自由文字，不会再被引号弄坏
function splitHead(raw: string) {
  const t = raw
    .trim()
    .replace(/^```(?:json|text|markdown)?\s*/i, "")
    .replace(/```\s*$/, "")
    .trim();
  const m = t.match(/^-{3,}\s*$/m);
  if (!m || m.index === undefined) return { head: t, body: "" };
  return { head: t.slice(0, m.index).trim(), body: t.slice(m.index + m[0].length).trim() };
}

// 人物卡正文：身份：… / 说话：… / 外貌：… 一行一条
function cardFromBody(body: string) {
  let identity = "";
  let speech = "";
  const fields: { k: string; v: string }[] = [];
  body
    .split(/\n+/)
    .map((l) => l.trim().replace(/^[-*·•]\s*/, ""))
    .filter(Boolean)
    .forEach((line) => {
      const m = line.match(/^([^：:]{1,10})[：:]\s*(.+)$/);
      if (!m) {
        if (!identity) identity = line;
        else fields.push({ k: "其它", v: line });
        return;
      }
      const k = m[1].trim();
      const v = m[2].trim();
      if (/^身份$/.test(k)) identity = v;
      else if (/^(说话|说话方式)$/.test(k)) speech = v;
      else fields.push({ k, v });
    });
  return { identity, speech, fields: fields.slice(0, 6) };
}

function parseAssistant(raw: string): { say: string; write?: AiWrite } {
  const { head, body } = splitHead(raw);
  const j = pullJson(head) || pullJson(raw);
  if (!j) {
    // 没按格式回：整段当它说的话，不动设定
    return { say: head.replace(/```/g, "").trim() };
  }
  const say = typeof j.say === "string" ? j.say.trim() : pullSay(head);
  const mode: "append" | "replace" = j.mode === "replace" ? "replace" : "append";
  let text = typeof j.text === "string" && j.text.trim() ? String(j.text).trim() : body;
  // 忘了写 --- 的情况：把 JSON 头后面剩下的字当正文
  if (!text && (j.target || j.block)) {
    const idx = head.lastIndexOf("}");
    const rest = idx >= 0 ? head.slice(idx + 1).trim() : "";
    if (rest) text = rest;
  }

  // 旧格式：write 整块塞在 JSON 里
  const rawWrite = j.write;
  const w = (typeof rawWrite === "string" ? pullJson(rawWrite) : rawWrite || null) as {
    type?: string;
    name?: string;
    identity?: string;
    speech?: string;
    fields?: { k?: string; v?: string }[];
    text?: string;
    block?: string;
    mode?: string;
  } | null;
  if (w) {
    const wMode: "append" | "replace" = w.mode === "replace" ? "replace" : "append";
    const isMe =
      w.type === "protagonist" || (typeof w.block === "string" && ME_NAMES.includes(w.block.trim()));
    if (w.type === "character" || w.name) {
      return {
        say,
        write: {
          type: "character",
          name: String(w.name || "未命名"),
          identity: String(w.identity || ""),
          speech: String(w.speech || ""),
          fields: Array.isArray(w.fields)
            ? w.fields.filter((f) => f && (f.k || f.v)).map((f) => ({ k: String(f.k || ""), v: String(f.v || "") }))
            : [],
        },
      };
    }
    if (isMe && w.text) return { say, write: { type: "protagonist", text: String(w.text), mode: wMode } };
    if (w.text) return { say, write: { type: "block", block: String(w.block || "世界总览"), text: String(w.text), mode: wMode } };
    return { say };
  }

  // 新格式：看 target
  const target = String(j.target || j.type || "").toLowerCase();
  if (target === "character") {
    const card = cardFromBody(text);
    const name = String(j.name || "").trim() || "未命名";
    return {
      say,
      write: {
        type: "character",
        name,
        identity: String(j.identity || card.identity),
        speech: String(j.speech || card.speech),
        fields: card.fields,
      },
    };
  }
  if (target === "me" || target === "protagonist") {
    return text ? { say, write: { type: "protagonist", text, mode } } : { say };
  }
  if (target === "block" || j.block) {
    return text
      ? { say, write: { type: "block", block: String(j.block || "世界总览"), text, mode } }
      : { say };
  }
  return { say };
}

function writeTitle(w: AiWrite, known: Set<string>) {
  if (w.type === "character") {
    return known.has(w.name.trim()) ? `改写人物「${w.name}」` : `新人物「${w.name}」`;
  }
  if (w.type === "protagonist") {
    return w.mode === "replace" ? "改写「我」· 会换掉原来那段" : "写进「我」";
  }
  return w.mode === "replace" ? `改写「${w.block}」· 会换掉原来那段` : `写进「${w.block}」`;
}

function writePreview(w: AiWrite) {
  if (w.type === "character") {
    // 旧会话里可能存着没有 fields 的卡，别让渲染炸掉
    const fields = Array.isArray(w.fields) ? w.fields : [];
    return [
      w.identity ? `身份 · ${w.identity}` : "",
      w.speech ? `说话 · ${w.speech}` : "",
      ...fields.map((f) => `${f.k || "其它"} · ${f.v}`),
    ]
      .filter(Boolean)
      .join("\n");
  }
  return w.text;
}

export default function SettingPage() {
  // 静态导出没有动态路由，世界 id 改从查询串读；useSearchParams 必须包在 Suspense 里
  return (
    <Suspense
      fallback={
        <main className="page">
          <div className="loading">正在翻开</div>
        </main>
      }
    >
      <Setting />
    </Suspense>
  );
}

function Setting() {
  const search = useSearchParams();
  const worldId = search.get("id") || "";
  const [world, setWorld] = useState<World | null>(null);
  const [loading, setLoading] = useState(true);
  const [editingSource, setEditingSource] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [meOpen, setMeOpen] = useState(false);
  const [noteOpen, setNoteOpen] = useState<string | null>(null);
  const [aiOpen, setAiOpen] = useState(false);
  const [aiInput, setAiInput] = useState("");
  const [aiBusy, setAiBusy] = useState(false);
  const [aiErr, setAiErr] = useState("");
  const [aiFailed, setAiFailed] = useState(false);
  const [aiDone, setAiDone] = useState<Record<number, boolean>>({});
  const [netBusy, setNetBusy] = useState(false);
  const [netInfo, setNetInfo] = useState<{ found: number; picked: number } | null>(null);
  const [netErr, setNetErr] = useState("");
  const [aiMsgs, setAiMsgs] = useState<
    { role: "user" | "assistant"; text: string; write?: AiWrite; note?: string }[]
  >([]);
  const [draft, setDraft] = useState({ title: "", hasSource: false, sourceTitle: "" });
  const [aiHydrated, setAiHydrated] = useState(false);
  const dirty = useRef(false);
  // 防抖那 500 毫秒里离开页面的话，改动会跟着 cleanup 一起被扔掉；
  // 卸载时补一次，改完马上回去开演也能带上新设定。
  const latest = useRef<World | null>(null);
  const aiBodyRef = useRef<HTMLDivElement>(null);
  const aiKey = `wenyou.assistant.${worldId}`;

  useEffect(() => {
    try {
      const raw = localStorage.getItem(aiKey);
      if (raw) {
        const j = JSON.parse(raw);
        if (Array.isArray(j?.msgs)) {
          // 旧会话里存下的整段 JSON，恢复成正常的话
          const msgs = (j.msgs as typeof aiMsgs).slice(-40).map((m) =>
            m.role === "assistant" && !m.write ? { ...m, text: tidyHistory(m.text) } : m,
          );
          setAiMsgs(msgs);
        }
        if (j?.done && typeof j.done === "object") setAiDone(j.done as Record<number, boolean>);
      }
    } catch {
      /* 存坏了就当没有 */
    }
    setAiHydrated(true);
  }, [aiKey]);

  useEffect(() => {
    if (!aiHydrated) return;
    try {
      const keep = aiMsgs.slice(-40);
      const off = aiMsgs.length - keep.length;
      const done: Record<number, boolean> = {};
      Object.entries(aiDone).forEach(([k, v]) => {
        const n = Number(k);
        if (!Number.isFinite(n)) return;
        if (n >= off) done[n - off] = v;
      });
      localStorage.setItem(aiKey, JSON.stringify({ msgs: keep, done }));
    } catch {
      /* 存不下就算了 */
    }
  }, [aiHydrated, aiMsgs, aiDone, aiKey]);

  useEffect(() => {
    if (!aiOpen) return;
    const el = aiBodyRef.current;
    if (!el) return;
    const id = requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight;
    });
    return () => cancelAnimationFrame(id);
  }, [aiOpen, aiMsgs, aiBusy, aiErr]);

  useEffect(() => {
    (async () => {
      let w = await getWorld(worldId);
      if (!w) {
        setLoading(false);
        return;
      }
      // 「我」和「主角」是同一栏。主角栏已有内容就只清掉残留的块，没有才把它搬进去。
      // 以前只在主角栏为空时才并，主角栏一有内容，旧档里的「主角」块就会一直留着。
      const strays = w.blocks.filter((b) => ME_NAMES.includes(b.title.trim()) && b.content.trim());
      if (strays.length) {
        w = {
          ...w,
          protagonist: w.protagonist?.trim()
            ? w.protagonist
            : strays.map((b) => b.content.trim()).join("\n"),
          blocks: w.blocks.filter((b) => !strays.some((s) => s.id === b.id)),
        };
        await putWorld(w);
      }
      setWorld(w);
      setLoading(false);
    })();
  }, [worldId]);

  useEffect(() => {
    if (!world) return;
    latest.current = world;
    if (!dirty.current) return;
    const t = setTimeout(() => putWorld(world), 500);
    return () => clearTimeout(t);
  }, [world]);

  useEffect(
    () => () => {
      if (dirty.current && latest.current) void putWorld(latest.current);
    },
    [],
  );

  function update(next: World) {
    dirty.current = true;
    setWorld(next);
  }

  function updateBlock(id: string, patch: Partial<Block>) {
    if (!world) return;
    update({ ...world, blocks: world.blocks.map((b) => (b.id === id ? { ...b, ...patch } : b)) });
  }

  function addBlock() {
    if (!world) return;
    update({
      ...world,
      blocks: [...world.blocks, { id: newId(), title: "新目录", content: "" }],
    });
  }

  function removeBlock(id: string) {
    if (!world) return;
    if (!confirm("这块连同里面的字一起删掉？")) return;
    update({ ...world, blocks: world.blocks.filter((b) => b.id !== id) });
  }

  function addNote() {
    if (!world) return;
    const id = newId();
    update({
      ...world,
      notes: [...(world.notes || []), { id, title: "", content: "" }],
    });
    setNoteOpen(id);
  }

  function updateNote(id: string, patch: Partial<Note>) {
    if (!world) return;
    update({
      ...world,
      notes: (world.notes || []).map((n) => (n.id === id ? { ...n, ...patch } : n)),
    });
  }

  function removeNote(id: string) {
    if (!world) return;
    if (!confirm("这条世界书删掉？")) return;
    update({ ...world, notes: (world.notes || []).filter((n) => n.id !== id) });
  }

  function openSource() {
    if (!world) return;
    setDraft({ title: world.title, hasSource: world.hasSource, sourceTitle: world.sourceTitle });
    setEditingSource(true);
  }

  function saveSource() {
    if (!world) return;
    update({
      ...world,
      title: draft.title.trim() || "未命名",
      hasSource: draft.hasSource,
      sourceTitle: draft.hasSource ? draft.sourceTitle.trim() : "",
    });
    setEditingSource(false);
  }

  async function runAi(next: typeof aiMsgs) {
    if (!world) return;
    const all = loadSettings();
    const cfg = all.assistant;
    if (!cfg.apiKey.trim()) {
      setAiErr("助手还没接，先去设置里填 Key。");
      setAiFailed(false);
      return;
    }
    setAiErr("");
    setAiFailed(false);
    setAiBusy(true);
    try {
      // 话里带「查 / 搜 / 资料」就先联网查一次，把摘要一起交给它
      const ask = [...next].reverse().find((m) => m.role === "user")?.text || "";
      let extra = "";
      let note = "";
      if (/查|搜|资料|百科|官网|最新|网上/.test(ask)) {
        if (!all.search.apiKey.trim()) {
          note = "搜索 Key 还没填，这次没联网。";
        } else if (!world.sourceTitle.trim()) {
          note = "没填原著作品名，这次没联网。";
        } else {
          const kw = ask
            .replace(
              /帮我|麻烦|能不能|可不可以|请你|帮忙|联网|网上|一下|查一查|查查|查|搜一搜|搜搜|搜|资料|百科|官网|最新|设定|人物|角色|剧情|世界观|的/g,
              " ",
            )
            .replace(/[，。？！,.:：\s]+/g, " ")
            .trim()
            .slice(0, 30);
          try {
            const sr = await fetch("/api/search", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                provider: all.search.provider,
                apiKey: all.search.apiKey,
                query: [world.sourceTitle, kw, "设定"].filter(Boolean).join(" "),
              }),
            });
            const sd = await sr.json().catch(() => null);
            if (!sr.ok) throw new Error(sd?.error || "没查到");
            const hits: { title: string; snippet: string }[] = (sd?.results || []).slice(0, 5);
            if (hits.length) {
              extra =
                `\n\n【下面是刚从网上查到的资料，只作参考；和已写设定冲突时，以已写设定为准】\n` +
                hits.map((h, i) => `${i + 1}. ${h.title}\n${h.snippet}`).join("\n");
              note = `查了「${kw || world.sourceTitle}」，看到 ${hits.length} 条`;
            } else {
              note = `查了「${kw || world.sourceTitle}」，没搜到，按已有设定答。`;
            }
          } catch (e) {
            note = `联网没成：${e instanceof Error ? e.message : "没查到"}`;
          }
        }
      }
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          baseUrl: cfg.baseUrl,
          apiKey: cfg.apiKey,
          model: cfg.model,
          messages: [
            { role: "system", content: assistantSystem(world) + extra },
            // 空正文的助手消息别发给模型，有的接口会因此回空
            ...next
              .filter((m) => m.role === "user" || m.text.trim())
              .map((m) => ({ role: m.role, content: m.role === "assistant" ? tidyHistory(m.text) : m.text })),
          ],
          // 助手要吐「JSON 头 + 正文」，别让接口把整段锁成 JSON
          json: false,
        }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error || "没回话");
      const raw = String(data?.content || "");
      const parsed = parseAssistant(raw);
      const say = parsed.say.trim();
      const write = parsed.write;

      // 真的什么都没回，才让人再点一次
      if (!say && !write) throw new Error("它这次什么都没回。再点一次「再说一次」试试。");
      const text = say ? say : write ? "写好了，看着改。" : "…";
      setAiMsgs([...next, { role: "assistant", text, write, note: note || undefined }]);
      setAiFailed(false);
    } catch (e) {
      setAiErr(e instanceof Error ? e.message : "没回话");
      setAiFailed(true);
    } finally {
      setAiBusy(false);
    }
  }

  async function sendAi() {
    const q = aiInput.trim();
    if (!q || aiBusy || !world) return;
    setAiInput("");
    const next: typeof aiMsgs = [...aiMsgs, { role: "user", text: q }];
    setAiMsgs(next);
    await runAi(next);
  }

  async function retryAi() {
    if (aiBusy || !aiMsgs.length) return;
    // 失败时最后一条还停在玩家的话上，直接拿它再问一次
    if (aiMsgs[aiMsgs.length - 1].role !== "user") return;
    await runAi(aiMsgs);
  }

  function writeInto(i: number, w: AiWrite) {
    if (!world) return;
    if (w.type === "character") {
      const exist = world.characters.find((c) => c.name.trim() === w.name.trim());
      const characters = exist
        ? world.characters.map((c) =>
            c.id === exist.id
              ? {
                  ...c,
                  identity: w.identity || c.identity,
                  speech: w.speech || c.speech,
                  fields: w.fields.length ? w.fields : c.fields,
                }
              : c
          )
        : [
            ...world.characters,
            {
              id: newId(),
              name: w.name,
              identity: w.identity,
              speech: w.speech,
              voiceId: "",
              fields: w.fields,
            },
          ];
      update({ ...world, characters });
      setAiDone({ ...aiDone, [i]: true });
      return;
    }

    if (w.type === "protagonist") {
      const cur = (world.protagonist || "").trim();
      const nextText = w.text.trim();
      update({
        ...world,
        protagonist: w.mode === "replace" ? nextText : [cur, nextText].filter(Boolean).join("\n"),
      });
      setAiDone({ ...aiDone, [i]: true });
      return;
    }

    const exist = world.blocks.find((b) => b.title === w.block);
    const nextText = w.text.trim();
    const blocks = exist
      ? world.blocks.map((b) =>
          b.id === exist.id
            ? {
                ...b,
                content:
                  w.mode === "replace"
                    ? nextText
                    : [b.content.trim(), nextText].filter(Boolean).join("\n"),
              }
            : b
        )
      : [...world.blocks, { id: newId(), title: w.block, content: nextText }];
    update({ ...world, blocks });
    setAiDone({ ...aiDone, [i]: true });
  }

  async function searchNet() {
    if (!world || netBusy) return;
    if (!world.sourceTitle.trim()) {
      setNetErr("先填原著作品名。");
      return;
    }
    const cfg = loadSettings();
    if (!cfg.search.apiKey.trim()) {
      setNetErr("联网还没接，先去设置里填搜索 Key。");
      return;
    }
    if (!cfg.assistant.apiKey.trim()) {
      setNetErr("助手还没接，先去设置里填 Key。");
      return;
    }
    setNetBusy(true);
    setNetErr("");
    try {
      const sr = await fetch("/api/search", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          provider: cfg.search.provider,
          apiKey: cfg.search.apiKey,
          query: `${world.sourceTitle} 世界观 设定 人物`,
        }),
      });
      const sd = await sr.json().catch(() => null);
      if (!sr.ok) throw new Error(sd?.error || "没查到");
      const hits: { title: string; snippet: string }[] = sd.results || [];

      const cr = await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          baseUrl: cfg.assistant.baseUrl,
          apiKey: cfg.assistant.apiKey,
          model: cfg.assistant.model,
          messages: [
            { role: "system", content: netSystem(world, hits) },
            { role: "user", content: "按规则挑，只留能用的。" },
          ],
        }),
      });
      const cd = await cr.json().catch(() => null);
      if (!cr.ok) throw new Error(cd?.error || "助手没回话");

      let j: { writes?: { block?: string; text?: string }[]; drop?: string[] } = {};
      try {
        j = JSON.parse(String(cd?.content || ""));
      } catch {
        throw new Error("助手没按格式回，再查一次。");
      }
      const writes: AiWrite[] = (j.writes || [])
        .filter((w) => w && typeof w.text === "string" && w.text.trim())
        .map((w) => {
          const block = String(w.block || "世界总览");
          const text = String(w.text).trim();
          if (ME_NAMES.includes(block.trim())) {
            return { type: "protagonist" as const, text, mode: "append" as const };
          }
          return { type: "block" as const, block, text, mode: "append" as const };
        });
      const drop = (j.drop || []).filter((d) => typeof d === "string" && d.trim());

      const say = `查回 ${hits.length} 条，挑出 ${writes.length} 条${
        drop.length ? `；跟你的设定打架、没写的 ${drop.length} 条：${drop.join("；")}` : "。"
      }`;
      setAiMsgs([
        ...aiMsgs,
        { role: "user", text: `联网查 ${world.sourceTitle}` },
        { role: "assistant", text: say },
        ...writes.map((w) => ({ role: "assistant" as const, text: "", write: w })),
      ]);
      setAiDone({});
      setNetInfo({ found: hits.length, picked: writes.length });
    } catch (e) {
      setNetErr(e instanceof Error ? e.message : "联网没成");
    } finally {
      setNetBusy(false);
    }
  }

  if (loading) {
    return (
      <main className="page">
        <div className="loading">正在翻开</div>
      </main>
    );
  }

  if (!world) {
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

  const filled = world.blocks.filter((b) => b.content.trim()).length;
  const approved = Object.values(aiDone).filter(Boolean).length;
  const styleIdx = world.blocks.findIndex((b) => b.title === "文风");
  const charAt = styleIdx >= 0 ? styleIdx : world.blocks.length;
  const knownNames = new Set(world.characters.map((c) => c.name.trim()));

  const charBlock = (
    <div className="blockedit" key="characters">
      <div className="bh">
        <b>人物</b>
        <em>{world.characters.length ? `${world.characters.length} 人` : "空"}</em>
      </div>
      {world.characters.length > 0 && (
        <div className="chcards">
          {world.characters.map((c) => (
            <Link className="chcard" href={`/world/character/?id=${world.id}&cid=${c.id}`} key={c.id}>
              <span className="cf">
                {c.avatar ? <img src={c.avatar} alt="" /> : (c.name || "？").slice(0, 1)}
              </span>
              <span className="cn">{c.name || "未命名"}</span>
            </Link>
          ))}
        </div>
      )}
      <Link className="cnew" href={`/world/character/?id=${world.id}&cid=new`}>
        ＋ 新建一张
      </Link>
    </div>
  );

  const notes = world.notes || [];
  const worldBook = (
    <div className="blockedit" key="notes">
      <div className="bh">
        <b>世界书</b>
        <em>{notes.length ? `${notes.length} 条` : "空 · 加一条。"}</em>
      </div>
      {notes.map((n) => {
        const open = noteOpen === n.id;
        return (
          <div
            className={open ? "notecard open" : "notecard"}
            key={n.id}
            onBlur={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setNoteOpen(null);
            }}
          >
            <div className="notehead" onClick={() => { if (!open) setNoteOpen(n.id); }}>
              {open ? (
                <input
                  value={n.title}
                  placeholder="标题，比如：活人感"
                  aria-label="世界书标题"
                  autoFocus
                  onChange={(e) => updateNote(n.id, { title: e.target.value })}
                />
              ) : (
                <b>{n.title.trim() || "未命名"}</b>
              )}
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  removeNote(n.id);
                }}
              >
                删
              </button>
            </div>
            {open ? (
              <textarea
                value={n.content}
                placeholder="照这个写：语气习惯、说话节奏、能破到什么程度、不许写什么。"
                onChange={(e) => updateNote(n.id, { content: e.target.value })}
              />
            ) : n.content.trim() ? (
              <p className="notetext">{n.content}</p>
            ) : (
              <p className="notetext empty">点开写。</p>
            )}
          </div>
        );
      })}
      <button type="button" className="cnew" onClick={addNote}>
        ＋ 加一条
      </button>
    </div>
  );

  return (
    <main className="page">
      <WorldTabs worldId={world.id} title={world.title} active="setting" />

      <textarea
        className="oneline-input"
        rows={2}
        placeholder="一句话说清这个世界。"
        value={world.summary}
        onChange={(e) => update({ ...world, summary: e.target.value })}
      />

      <div className="srcbar">
        <span>{world.hasSource && world.sourceTitle ? `原著 · ${world.sourceTitle}` : "原创 · 无原著"}</span>
        <i />
        <span>{world.characters.length} 人</span>
        {world.hasSource && world.sourceTitle ? (
          <button type="button" className="netbtn" onClick={searchNet} disabled={netBusy}>
            {netBusy ? "联网中…" : "联网查"}
          </button>
        ) : null}
        <button type="button" onClick={openSource} style={{ marginLeft: "auto", background: "none", border: "none", color: "var(--seal)", fontSize: 10 }}>
          改
        </button>
      </div>

      {netInfo && (
        <div className="netbar">
          <span>
            联网查回 {netInfo.found} 条 · 已写进 {approved} 条
          </span>
          <button type="button" onClick={() => setAiOpen(true)}>
            过一眼 ›
          </button>
        </div>
      )}
      {netErr && <p className="neterr">{netErr}</p>}

      <div className="toc">
        <div className="tochead">
          <b>目录</b>
          <span>草稿</span>
        </div>

        <div className={meOpen || world.protagonist?.trim() ? "blockedit" : "blockedit closed"}>
          <div className="bh" onClick={() => setMeOpen(true)}>
            <b>我</b>
            <em>
              {world.protagonist?.trim()
                ? `${world.protagonist.trim().split(/\n+/).length} 条`
                : "空 · 点开写。"}
            </em>
          </div>
          {(meOpen || Boolean(world.protagonist?.trim())) && (
            <textarea
              value={world.protagonist || ""}
              placeholder="你是谁：名字、身份、脾气，一句也行。"
              autoFocus={meOpen}
              onChange={(e) => update({ ...world, protagonist: e.target.value })}
              onBlur={(e) => {
                if (!e.target.value.trim()) setMeOpen(false);
              }}
            />
          )}
        </div>

        {world.blocks.map((b, i) => {
          const text = b.content.trim();
          const open = Boolean(text) || openId === b.id;
          const mark =
            i === charAt ? (
              <>
                {charBlock}
                {worldBook}
              </>
            ) : null;

          if (!open) {
            return (
              <Fragment key={b.id}>
                {mark}
                <div className="blockedit closed">
                  <div className="bh" onClick={() => setOpenId(b.id)}>
                    <b>{b.title}</b>
                    <em>空 · 点开写。</em>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        removeBlock(b.id);
                      }}
                    >
                      删
                    </button>
                  </div>
                </div>
              </Fragment>
            );
          }

          return (
            <Fragment key={b.id}>
              {mark}
              <div className="blockedit">
                <div className="bh">
                  <input
                    value={b.title}
                    aria-label="目录名"
                    onChange={(e) => updateBlock(b.id, { title: e.target.value })}
                  />
                  <em>{text ? `${text.split(/\n+/).length} 条` : "空"}</em>
                  <button type="button" onClick={() => removeBlock(b.id)}>
                    删
                  </button>
                </div>
                <textarea
                  value={b.content}
                  placeholder="点开写。"
                  autoFocus={openId === b.id}
                  onChange={(e) => updateBlock(b.id, { content: e.target.value })}
                  onBlur={(e) => {
                    if (!e.target.value.trim()) setOpenId(null);
                  }}
                />
              </div>
            </Fragment>
          );
        })}

        {charAt === world.blocks.length && (
          <>
            {charBlock}
            {worldBook}
          </>
        )}

        <button type="button" className="tadd" onClick={addBlock}>
          ＋ 新建目录
        </button>

        <div className="meta">
          <span>
            写了 <b>{filled} / {world.blocks.length}</b>
          </span>
          <i />
          <span>
            人物 <b>{world.characters.length}</b>
          </span>
          <Link href={`/world/characters/?id=${world.id}`}>去建人物 ›</Link>
        </div>
      </div>

      <footer className="colophon">
        <div className="rule" />
        <div className="act">
          <button type="button" className="aside" onClick={() => setAiOpen(true)}>
            世界小助手<em>让它帮你写</em>
          </button>
          <Link className="go" href={`/world/?id=${world.id}`}>
            去开演<u>→</u>
          </Link>
        </div>
      </footer>

      {editingSource && (
        <div className="mask" onClick={() => setEditingSource(false)}>
          <div className="sheet" onClick={(e) => e.stopPropagation()}>
            <h2>这个世界</h2>
            <div className="field">
              <label>名字</label>
              <input className="inp" value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
            </div>
            <div className="field">
              <label>有没有原著</label>
              <div className="seg">
                <button type="button" className={!draft.hasSource ? "on" : ""} onClick={() => setDraft({ ...draft, hasSource: false })}>
                  原创
                </button>
                <button type="button" className={draft.hasSource ? "on" : ""} onClick={() => setDraft({ ...draft, hasSource: true })}>
                  有原著
                </button>
              </div>
            </div>
            {draft.hasSource && (
              <div className="field">
                <label>作品名</label>
                <input
                  className="inp"
                  value={draft.sourceTitle}
                  placeholder="比如 崩坏：星穹铁道"
                  onChange={(e) => setDraft({ ...draft, sourceTitle: e.target.value })}
                />
              </div>
            )}
            <div className="sheetact">
              <button type="button" className="btn" onClick={saveSource}>
                存下
              </button>
              <button type="button" className="cancel" onClick={() => setEditingSource(false)}>
                取消
              </button>
            </div>
          </div>
        </div>
      )}

      {aiOpen && (
        <div className="aiwrap">
          <div className="aimask" onClick={() => setAiOpen(false)} />
          <aside className="aidrawer">
            <div className="aihead">
              <b>世界小助手</b>
              <button
                type="button"
                className="aiclear"
                onClick={() => {
                  setAiMsgs([]);
                  setAiDone({});
                  setNetInfo(null);
                }}
              >
                清空
              </button>
              <button type="button" className="aiclose" onClick={() => setAiOpen(false)}>
                收起
              </button>
            </div>

            <div className="aibody" ref={aiBodyRef}>
              {aiMsgs.length === 0 && (
                <p className="aihint">
                  说一句这个世界要什么。
                  <br />
                  它写出来，你点头才落笔。
                </p>
              )}
              {aiMsgs.map((m, i) =>
                m.role === "user" ? (
                  <div className="aiu" key={i}>
                    {m.text}
                  </div>
                ) : (
                  <div className="aia" key={i}>
                    {m.note ? <em className="ainote">{m.note}</em> : null}
                    {m.text ? <p>{m.text}</p> : null}
                    {m.write && (
                      <div className="aiw">
                        <span>{writeTitle(m.write, knownNames)}</span>
                        <pre>{writePreview(m.write)}</pre>
                        {aiDone[i] !== undefined ? (
                          <em>
                            {aiDone[i]
                              ? m.write.type === "character"
                                ? "已写进人物"
                                : m.write.mode === "replace"
                                  ? "已替换"
                                  : "已写进去"
                              : "放着没写"}
                          </em>
                        ) : (
                          <div className="aiwa">
                            <button type="button" onClick={() => writeInto(i, m.write!)}>
                              {m.write.type === "character"
                                ? "写进人物"
                                : m.write.mode === "replace"
                                  ? "替换掉"
                                  : "写进去"}
                            </button>
                            <button
                              type="button"
                              className="no"
                              onClick={() => setAiDone({ ...aiDone, [i]: false })}
                            >
                              不写
                            </button>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )
              )}
              {aiBusy && <div className="aibusy">正在写</div>}
              {aiErr && (
                <div className="aierr">
                  <span>{aiErr}</span>
                  {aiFailed && (
                    <button type="button" onClick={retryAi} disabled={aiBusy}>
                      再说一次
                    </button>
                  )}
                </div>
              )}
            </div>

            <div className="aifoot">
              <textarea
                rows={2}
                placeholder="比如：补一下这座城的来历。"
                value={aiInput}
                onChange={(e) => setAiInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault();
                    sendAi();
                  }
                }}
              />
              <button type="button" onClick={sendAi} disabled={aiBusy || !aiInput.trim()}>
                交给它
              </button>
            </div>
          </aside>
        </div>
      )}
    </main>
  );
}
