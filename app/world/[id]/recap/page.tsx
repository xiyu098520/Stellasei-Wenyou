"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { getSave, getWorld, putSave } from "@/lib/db";
import {
  CHAPTER_TURNS,
  Save,
  chapterLabel,
  chapterTitleOf,
  emptySave,
  turnsOf,
  World,
} from "@/lib/types";

const CN = ["一", "二", "三", "四", "五", "六", "七", "八", "九", "十"];
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + "…" : s);

export default function RecapPage() {
  const params = useParams<{ id: string }>();
  const worldId = params.id;
  const router = useRouter();
  const [world, setWorld] = useState<World | null>(null);
  const [save, setSave] = useState<Save | null>(null);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState<string | null>(null);
  // 默认只展开当前这一章；小回合都收在自己的章节里，不铺满一屏
  const [openCh, setOpenCh] = useState<number[] | null>(null);
  const [wipe, setWipe] = useState(false);
  const [back, setBack] = useState("");

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

  // 清空这一册：回合、章节、关系、伏笔全扔掉，开场那句话留着
  async function clearAll() {
    if (!save) return;
    await putSave({ ...emptySave(worldId), seed: save.seed });
    router.replace(`/world/${worldId}`);
  }

  return (
    <main className="page">
      <div className="topbar">
        <Link className="where" href={`/world/${world.id}`}>
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
            <span>{back || `${rows.length} 章`}</span>
          </div>
          {rows.map((r) => {
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
                {r.a} ↔ {r.b}：{r.state}
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
          <Link className="go" href={`/world/${world.id}`}>
            去开演<u>→</u>
          </Link>
        </div>
      </footer>
    </main>
  );
}
