"use client";

import Link from "next/link";
import { Suspense, useEffect, useState } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { getSave, getWorld, putSave } from "@/lib/db";
import { archiveAsk, parseArchive } from "@/lib/prompt";
import { loadSettings } from "@/lib/settings";
import {
  CHAPTER_TURNS,
  Message,
  Save,
  chapterLabel,
  chapterTitleOf,
  emptySave,
  turnsOf,
  World,
} from "@/lib/types";

const CN = ["一", "二", "三", "四", "五", "六", "七", "八", "九", "十"];
// 亲密度五档的显示名，记的是「你走到哪一步」，跟世界设定里的阶段一一对应
const LEVELS = ["只当工作", "动摇", "承认", "越界", "在一起"];
const levelText = (lv?: number) =>
  typeof lv === "number" && LEVELS[lv] ? `L${lv} ${LEVELS[lv]}` : "";
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + "…" : s);

export default function RecapPage() {
  // 静态导出没有动态路由，世界 id 改从查询串读；useSearchParams 必须包在 Suspense 里
  return (
    <Suspense
      fallback={
        <main className="page">
          <div className="loading">正在翻开</div>
        </main>
      }
    >
      <Recap />
    </Suspense>
  );
}

function Recap() {
  const search = useSearchParams();
  const worldId = search.get("id") || "";
  const router = useRouter();
  const [world, setWorld] = useState<World | null>(null);
  const [save, setSave] = useState<Save | null>(null);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState<string | null>(null);
  // 默认只展开当前这一章；小回合都收在自己的章节里，不铺满一屏
  const [openCh, setOpenCh] = useState<number[] | null>(null);
  const [wipe, setWipe] = useState(false);
  const [back, setBack] = useState("");
  // 「重写本章档案」：一次只跑一章，结果就近显示在那一章下面
  const [busyCh, setBusyCh] = useState<number | null>(null);
  const [note, setNote] = useState<{ i: number; text: string } | null>(null);
  // 章节列表整块先收起来：十五六章的名字摆一屏，正文都被挤下去了
  const [listOpen, setListOpen] = useState(false);

  useEffect(() => {
    (async () => {
      const w = await getWorld(worldId);
      if (!w) {
        setLoading(false);
        return;
      }
      const s = await getSave(worldId);
      setWorld(w);
      setSave(s);
      setLoading(false);
    })();
  }, [worldId]);

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

  const turns = turnsOf(save);
  const total = Math.floor(turns / CHAPTER_TURNS) + 1;
  // 早前整章砍掉过的章：原文没了，只剩档案
  const droppedChapters = Math.floor((save.droppedTurns || 0) / CHAPTER_TURNS);

  const rows = Array.from({ length: total }, (_, i) => {
    const num = i + 1;
    const label = `第${CN[i] || num}章`;
    const title = chapterTitleOf(save, num);
    const a = save.archive?.[i];
    const span = a?.period?.trim();
    return {
      num,
      name: `${title ? `${label} · ${title}` : label}${span ? `（${span}）` : ""}`,
      recap: a?.state || a?.summary || save.recaps?.[i] || "",
      events: a?.events || [],
      gone: i < droppedChapters,
      last: i === total - 1,
    };
  });

  const stats = world.characters
    .map((c) => {
      let count = 0;
      let last = "";
      save.messages.forEach((m) =>
        (m.segments || []).forEach((seg) => {
          if (seg.type === "line" && seg.speaker === c.name) {
            count += 1;
            last = seg.text;
          }
        }),
      );
      return { c, count, last };
    })
    .filter((x) => x.count > 0);

  const fallback = (() => {
    for (let i = save.messages.length - 1; i >= 0; i--) {
      const m = save.messages[i];
      if (m.role !== "assistant") continue;
      const body = (m.segments || [])
        .filter((seg) => seg.type !== "line")
        .map((seg) => seg.text)
        .join(" ");
      if (body) return clip(body, 140);
    }
    return "";
  })();

  const summary = world.summary || fallback;

  const userTurns = save.messages
    .map((m, i) => ({ m, i }))
    .filter(({ m }) => m.role === "user")
    .map((x, n) => ({ ...x, n: n + 1 + (save.droppedTurns || 0) }));

  const opened = openCh ?? [total];

  // 每一章自己的小回合：回合序号按 CHAPTER_TURNS 折回章节
  function turnsIn(num: number) {
    return userTurns.filter((t) => Math.ceil(t.n / CHAPTER_TURNS) === num);
  }

  function toggleCh(num: number) {
    setOpenCh(opened.includes(num) ? opened.filter((x) => x !== num) : [...opened, num]);
  }

  // 章节列表整块先收起来：十五六章的名字摆一屏，正文都被挤下去了
  function toggleAll() {
    const next = !listOpen;
    setListOpen(next);
    // 收起来时把展开过的章也一并收掉，下次点开是干净的一列
    if (!next) setOpenCh([]);
  }

  async function revert(index: number) {
    if (!save) return;
    const next: Save = {
      ...save,
      messages: save.messages.slice(0, index),
      updatedAt: Date.now(),
    };
    setSave(next);
    setPending(null);
    setBack("退回去了。后面那段不留。");
    await putSave(next);
  }

  // 把一批消息拼成可读的原文：玩家写的那句标出来，演出按段排下去
  function renderHistory(messages: Message[]) {
    return messages
      .map((m) => {
        if (m.role === "user") return `玩家：${m.text}`;
        return (m.segments || [])
          .map((s) => (s.type === "line" ? `${s.speaker || "某人"}${s.via ? `（${s.via}）` : ""}：「${s.text}」` : s.text))
          .join("\n");
      })
      .filter((t) => t.trim())
      .join("\n\n");
  }

  // 把某一章的原文捞出来喂给档案模型。回合号从被砍的地方接着数，跟世界页保持一致。
  function chapterTranscript(messages: Message[], idx: number, base = 0) {
    let turn = base;
    const out: Message[] = [];
    messages.forEach((m) => {
      if (m.role === "user") turn += 1;
      const at = Math.ceil(Math.max(turn, 1) / CHAPTER_TURNS) - 1;
      if (at === idx) out.push(m);
    });
    return renderHistory(out);
  }

  // 用那一章的原文重新生成档案，覆盖旧的那一份；recap 与标题不动，只把档案写厚
  async function rewriteChapter(i: number) {
    if (!save || !world) return;
    setBusyCh(i);
    setNote({ i, text: "正在重写…" });
    try {
      const cfg = loadSettings().assistant;
      if (!cfg.apiKey.trim()) throw new Error("设置里还没填总结模型的 Key");
      const transcript = chapterTranscript(save.messages, i, save.droppedTurns || 0);
      if (!transcript.trim()) throw new Error("这一章的原文已经不在了，没法重写");
      // 中间站偶尔会抽风（504、429、JSON 截断），同一个请求连试三次再判失败
      const pull = async () => {
        const res = await fetch("/api/chat", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            baseUrl: cfg.baseUrl,
            apiKey: cfg.apiKey,
            model: cfg.model,
            messages: archiveAsk(world, i + 1, transcript, save.clocks?.[i]),
            maxTokens: 6000,
            // 档案要写满一整章，一次性等整段 JSON 会被网关掐成 504，这里改边收边拼
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
        if (!parsed) throw new Error(`没写出来：${(raw || "（空回复）").slice(0, 120)}`);
        return parsed;
      };
      let entry: ReturnType<typeof parseArchive> = null;
      let lastErr: Error | null = null;
      for (let attempt = 1; attempt <= 3 && !entry; attempt += 1) {
        if (attempt > 1) {
          setNote({ i, text: `第 ${attempt} 次尝试…` });
          await new Promise((r) => setTimeout(r, 1500));
        }
        try {
          entry = await pull();
        } catch (err) {
          lastErr = err as Error;
        }
      }
      if (!entry) throw lastErr || new Error("重写失败");

      const cur = (await getSave(worldId)) || save;
      const archive = [...(cur.archive || [])];
      archive[i] = entry;
      const chapterTitles = [...(cur.chapterTitles || [])];
      if (!chapterTitles[i]?.trim() && entry.title) chapterTitles[i] = entry.title;
      const next: Save = { ...cur, archive, chapterTitles, updatedAt: Date.now() };
      await putSave(next);
      setSave(next);
      setNote({ i, text: `已重写：${entry.events.length} 条事件` });
    } catch (err) {
      setNote({ i, text: `失败：${(err as Error).message}` });
    } finally {
      setBusyCh(null);
    }
  }

  // 清空这一册：回合、章节、关系、伏笔全扔掉，开场那句话留着
  async function clearAll() {
    if (!save) return;
    await putSave({ ...emptySave(worldId), seed: save.seed });
    router.replace(`/world/?id=${worldId}`);
  }

  return (
    <main className="page fill">
      <div className="topbar">
        <Link className="where" href={`/world/?id=${world.id}`}>
          <u>‹</u>
          {world.title}
        </Link>
      </div>

      <div className="revhead">
        <h1>回顾</h1>
        <span>
          {chapterLabel(save)} · {turns} 回合
        </span>
      </div>

      {summary ? <p className="summary">{summary}</p> : null}

      <div className="revscroll">
        <div className="toc">
          <div className="tochead">
            <b>章节</b>
            <span>
              {back || `${rows.length} 章`}
              <button type="button" className="foldall" onClick={toggleAll}>
                {listOpen ? "收起" : "展开"}
              </button>
            </span>
          </div>
          {listOpen &&
            rows.map((r) => {
            const open = opened.includes(r.num);
            const list = turnsIn(r.num);
            return (
              <div key={r.num}>
                <button
                  type="button"
                  className={`trow wrap chapbtn${open ? " on" : ""}`}
                  aria-expanded={open}
                  onClick={() => toggleCh(r.num)}
                >
                  <b>{r.name}</b>
                  <i className="lead" />
                  <em>{r.gone ? "已归档" : r.last ? "进行中" : `${CHAPTER_TURNS} 回合`}</em>
                  <span className="chev">{open ? "收起" : "展开"}</span>
                </button>
                {open ? (
                  <div className="turns">
                    {r.recap ? <p className="trecap">{r.recap}</p> : null}
                    {r.events.map((e, k) => (
                      <p className="trecap" key={`${r.num}-${k}`}>
                        · {e}
                      </p>
                    ))}
                    {r.gone ? null : (
                      <button type="button" className="rearch" disabled={busyCh === r.num - 1} onClick={() => rewriteChapter(r.num - 1)}>
                        {busyCh === r.num - 1 ? "重写中…" : "重写本章档案"}
                      </button>
                    )}
                    {note && note.i === r.num - 1 ? <p className="renote">{note.text}</p> : null}
                    {list.length ? (
                      list.map(({ m, i }, k) => (
                        <div className="turnrow" key={m.id}>
                          <em>{String(k + 1).padStart(2, "0")}</em>
                          <p>{clip(m.text, 34)}</p>
                          {pending === m.id ? (
                            <span className="turnact">
                              <button type="button" onClick={() => revert(i)}>
                                退
                              </button>
                              <button type="button" className="no" onClick={() => setPending(null)}>
                                算了
                              </button>
                            </span>
                          ) : (
                            <button type="button" onClick={() => setPending(m.id)}>
                              退回
                            </button>
                          )}
                        </div>
                      ))
                    ) : r.gone && save.buried?.[r.num - 1]?.length ? (
                      <Link className="turnrow toward" href={`/world/archive/?id=${worldId}&ch=${r.num}`}>
                        <em>▸</em>
                        <p>看原文（{save.buried[r.num - 1].length} 条，只读）</p>
                        <span>打开</span>
                      </Link>
                    ) : (
                      <div className="blank">{r.gone ? "这一章已归档，原文不再保留。" : "这一章还没走。"}</div>
                    )}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>

        <div className="toc">
          <div className="tochead">
            <b>现在的关系</b>
            <span>{save.relations?.length || 0} 对</span>
          </div>
          {save.relations?.length ? (
            save.relations.map((r, i) => (
              <div className="debt" key={`${r.a}-${r.b}-${i}`}>
                {r.a} ↔ {r.b}：{levelText(r.level) ? `${levelText(r.level)} · ` : ""}
                {r.state}
              </div>
            ))
          ) : (
            <div className="blank">还没有记下关系。</div>
          )}
        </div>

        <div className="toc">
          <div className="tochead">
            <b>人物记得什么</b>
            <span>按人分开</span>
          </div>
          {stats.length ? (
            stats.map(({ c, count, last }) => (
              <div className="crow mem" key={c.id}>
                <span className="face">
                  {c.avatar ? <img src={c.avatar} alt="" /> : (c.name || "？").slice(0, 1)}
                </span>
                <div className="txt">
                  <h4>{c.name}</h4>
                  <p>
                    说过 {count} 句
                    {last ? `\n最近：${clip(last, 46)}` : ""}
                  </p>
                </div>
              </div>
            ))
          ) : (
            <div className="blank">还没有人开口。</div>
          )}
        </div>

        <div className="toc">
          <div className="tochead">
            <b>还欠着的</b>
            <span>{save.threads.length} 条</span>
          </div>
          {save.threads.length ? (
            save.threads.map((t, i) => (
              <div className="debt" key={`${t}-${i}`}>
                {t}
              </div>
            ))
          ) : (
            <div className="blank">还没有记下伏笔。</div>
          )}
        </div>
        <div className="toc">
          <div className="tochead">
            <b>清空</b>
            <span>从头开始</span>
          </div>
          <div className="wipe">
            <p>回合、章节、关系、伏笔，全部扔掉。世界设定、人物、开场那句话留着。</p>
            {wipe ? (
              <div className="wipeact">
                <button type="button" className="danger" onClick={clearAll}>
                  确实清空
                </button>
                <button type="button" className="no" onClick={() => setWipe(false)}>
                  算了
                </button>
              </div>
            ) : (
              <button type="button" className="wipeln" onClick={() => setWipe(true)}>
                把这一册清空，从头开始
              </button>
            )}
          </div>
        </div>
      </div>

      <footer className="colophon">
        <div className="rule" />
        <div className="act">
          <span className="aside">
            退一步<em>退掉的不留</em>
          </span>
          <Link className="go" href={`/world/?id=${world.id}`}>
            去开演<u>→</u>
          </Link>
        </div>
      </footer>
    </main>
  );
}
