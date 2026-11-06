"use client";

import Link from "next/link";
import { Suspense, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { getSave, getWorld, getVoiceClip, putVoiceClip } from "@/lib/db";
import { characterByName } from "@/lib/prompt";
import { loadSettings } from "@/lib/settings";
import type { Message, Segment, World } from "@/lib/types";

const CN = ["一", "二", "三", "四", "五", "六", "七", "八", "九", "十"];

// 已归档章节的只读回看：和世界页同一套 class、同一份语音缓存，
// 只是不能往回退、不能改，也不再参与提示词。
export default function ArchivePage() {
  return (
    <Suspense
      fallback={
        <main className="page">
          <div className="loading">正在翻开</div>
        </main>
      }
    >
      <Archive />
    </Suspense>
  );
}

function Archive() {
  const search = useSearchParams();
  const worldId = search.get("id") || "";
  const ch = Number(search.get("ch") || "") || 1;
  const [world, setWorld] = useState<World | null>(null);
  const [msgs, setMsgs] = useState<Message[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [playing, setPlaying] = useState<string>("");
  const [thread, setThread] = useState("");
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const urlCache = useRef(new Map<string, string>());

  useEffect(() => {
    (async () => {
      const w = await getWorld(worldId);
      const s = await getSave(worldId);
      setWorld(w || null);
      setMsgs((s.buried || [])[ch - 1] || []);
      setLoading(false);
    })();
  }, [worldId, ch]);

  useEffect(() => {
    return () => {
      audioRef.current?.pause();
      urlCache.current.forEach((u) => URL.revokeObjectURL(u));
    };
  }, []);

  // 和世界页同一套缓存键：语音参数、上下文、文本一样就吃本地那份，不再花额度
  async function clipFor(seg: Segment, segs: Segment[], idx: number) {
    const settings = loadSettings();
    const character = characterByName(world!, seg.speaker);
    const voiceId = character?.voiceId?.trim() || settings.voice.defaultVoiceId;
    const v3 = /v[3-9]/i.test(settings.voice.model);
    const tone = v3 ? (seg.tone || "").trim() : "";
    const spoken = (x?: Segment) =>
      (settings.voice.lang === "ja" ? x?.ja?.trim() || "" : "") || x?.text || "";
    const say = tone ? `${tone} ${spoken(seg)}` : spoken(seg);
    const prev = v3 && idx > 0 ? spoken(segs[idx - 1]).slice(-160) : "";
    const clipKey = [voiceId, settings.voice.model, settings.voice.speed ?? "", prev, say].join("|");
    const known = urlCache.current.get(clipKey);
    if (known) {
      const blob = await getVoiceClip(clipKey).catch(() => undefined);
      if (blob) return known;
    }
    const cached = await getVoiceClip(clipKey).catch(() => undefined);
    if (cached) {
      const url = URL.createObjectURL(cached);
      urlCache.current.set(clipKey, url);
      return url;
    }
    if (!settings.voice.apiKey.trim()) throw new Error("还没有填语音 Key。");
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
    void putVoiceClip(clipKey, blob).catch(() => {});
    const url = URL.createObjectURL(blob);
    urlCache.current.set(clipKey, url);
    return url;
  }

  async function play(seg: Segment, key: string, segs: Segment[], idx: number) {
    const el = audioRef.current ?? (audioRef.current = new Audio());
    if (playing === key) {
      el.pause();
      setPlaying("");
      return;
    }
    setPlaying(key);
    setThread("");
    try {
      el.pause();
      el.src = await clipFor(seg, segs, idx);
      el.onended = () => setPlaying("");
      await el.play();
    } catch (e) {
      setPlaying("");
      setThread((e as Error).message);
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

  const list = msgs || [];

  return (
    <main className="page">
      <div className="topbar">
        <Link className="where" href={`/world/recap/?id=${world.id}`}>
          <u>‹</u>回顾
        </Link>
      </div>

      <div className="revhead">
        <h1>第{CN[ch - 1] || ch}章 · 原文</h1>
        <span>只读 · 已归档</span>
      </div>

      {thread ? <p className="errhint">{thread}</p> : null}

      {list.length ? (
        list.map((m) =>
          m.role === "user" ? (
            <div className="blk you" key={m.id}>
              <span className="you-label">你</span>
              <div className="act">{m.text}</div>
            </div>
          ) : (
            (m.segments || []).map((seg, i) => {
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
                        onContextMenu={(e) => e.preventDefault()}
                        aria-label={playing === key ? "停止" : "念这句"}
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
            })
          ),
        )
      ) : (
        <p className="emptyhint">这一章的原文没有留下来（旧版砍章时还没开始存原文）。</p>
      )}
    </main>
  );
}
