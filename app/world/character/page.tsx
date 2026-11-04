"use client";

import Link from "next/link";
import { Suspense, useEffect, useRef, useState } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { getWorld, putWorld } from "@/lib/db";
import { readImage } from "@/lib/image";
import { Character, Field, newId, World } from "@/lib/types";

function blankCard(): Character {
  return { id: newId(), name: "", identity: "", speech: "", voiceId: "", fields: [] };
}

// 自动长高的输入框：写完多少字就显示多少行，页面照常上下滑
function Auto({
  value,
  onChange,
  placeholder,
  className,
  label,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  className?: string;
  label?: string;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [value]);
  return (
    <textarea
      ref={ref}
      rows={1}
      className={className}
      placeholder={placeholder}
      aria-label={label}
      value={value}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

export default function CharacterPage() {
  // 静态导出没有动态路由，世界 id 和人物 id 改从查询串读；useSearchParams 必须包在 Suspense 里
  return (
    <Suspense
      fallback={
        <main className="page">
          <div className="loading">正在翻开</div>
        </main>
      }
    >
      <CharacterEditor />
    </Suspense>
  );
}

function CharacterEditor() {
  const search = useSearchParams();
  const router = useRouter();
  const worldId = search.get("id") || "";
  const cid = search.get("cid") || "";
  const isNew = cid === "new";
  const [world, setWorld] = useState<World | null>(null);
  const [card, setCard] = useState<Character | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    (async () => {
      const w = await getWorld(worldId);
      if (!w) {
        setLoading(false);
        return;
      }
      setWorld(w);
      if (isNew) {
        setCard(blankCard());
      } else {
        setCard(w.characters.find((c) => c.id === cid) || null);
      }
      setLoading(false);
    })();
  }, [worldId, cid, isNew]);

  function set(patch: Partial<Character>) {
    setCard((c) => (c ? { ...c, ...patch } : c));
  }

  function setField(i: number, patch: Partial<Field>) {
    setCard((c) =>
      c ? { ...c, fields: c.fields.map((f, j) => (j === i ? { ...f, ...patch } : f)) } : c,
    );
  }

  async function pickAvatar(file?: File) {
    if (!file) return;
    try {
      const data = await readImage(file);
      set({ avatar: data });
    } catch {
      // 不是图片，忽略
    }
  }

  async function save(mode: "done" | "again") {
    if (!world || !card || busy) return;
    const name = card.name.trim();
    if (!name) return;
    setBusy(true);
    const cleaned: Character = {
      ...card,
      name,
      identity: card.identity.trim(),
      speech: card.speech.trim(),
      voiceId: card.voiceId.trim(),
      fields: card.fields.filter((f) => f.k.trim() || f.v.trim()),
    };
    const characters = isNew
      ? [...world.characters, cleaned]
      : world.characters.map((c) => (c.id === cleaned.id ? cleaned : c));
    const next: World = { ...world, characters };
    setWorld(next);
    await putWorld(next);
    setBusy(false);
    if (mode === "again") {
      setCard(blankCard());
    } else {
      router.push(`/world/characters/?id=${world.id}`);
    }
  }

  async function remove() {
    if (!world || !card) return;
    if (!confirm("这张卡连同写在里面的字一起删掉？")) return;
    const next: World = { ...world, characters: world.characters.filter((c) => c.id !== card.id) };
    setWorld(next);
    await putWorld(next);
    router.push(`/world/characters/?id=${world.id}`);
  }

  if (loading) {
    return (
      <main className="page">
        <div className="loading">正在翻开</div>
      </main>
    );
  }

  if (!world || !card) {
    return (
      <main className="page">
        <div className="topbar">
          <Link className="where" href={`/world/characters/?id=${worldId}`}>
            <u>‹</u>人物
          </Link>
        </div>
        <p className="emptyhint">这张卡不在了。</p>
      </main>
    );
  }

  return (
    <main className="page">
      <div className="topbar">
        <Link className="where" href={`/world/characters/?id=${world.id}`}>
          <u>‹</u>人物
        </Link>
        <nav className="tabs">
          <span style={{ fontSize: 10.5, letterSpacing: ".22em", color: "var(--ink-4)" }}>
            {isNew ? "新建人物" : "人物卡"}
          </span>
        </nav>
      </div>

      <div className="cardhead">
        <label className="bigface-edit">
          <span className="face bigface">
            {card.avatar ? <img src={card.avatar} alt="" /> : (card.name || "新").slice(0, 1)}
          </span>
          <input type="file" accept="image/*" onChange={(e) => pickAvatar(e.target.files?.[0])} />
          <span className="pick">换头像</span>
        </label>
        <div className="who">
          <input
            className="inp"
            placeholder="名字"
            aria-label="名字"
            value={card.name}
            autoFocus={isNew}
            onChange={(e) => set({ name: e.target.value })}
          />
          <Auto
            className="inp small"
            placeholder="身份，比如 学生会副会长 · 二年级"
            label="身份"
            value={card.identity}
            onChange={(v) => set({ identity: v })}
          />
        </div>
      </div>

      <div className="fields">
        <div className="frow2">
          <input className="k" value="说话方式" readOnly aria-label="说话方式" />
          <Auto
            className="v"
            placeholder="一句一顿，能不说就不说"
            value={card.speech}
            onChange={(v) => set({ speech: v })}
          />
        </div>

        <div className="frow2">
          <input className="k" value="音色 ID" readOnly aria-label="音色 ID" />
          <Auto
            className="v"
            placeholder="留空就用默认音色"
            value={card.voiceId}
            onChange={(v) => set({ voiceId: v })}
          />
        </div>

        {card.fields.map((f, i) => (
          <div className="frow2" key={i}>
            <input
              className="k"
              placeholder="格名"
              value={f.k}
              onChange={(e) => setField(i, { k: e.target.value })}
            />
            <Auto
              className="v"
              placeholder="内容"
              value={f.v}
              onChange={(v) => setField(i, { v })}
            />
            <button type="button" onClick={() => set({ fields: card.fields.filter((_, j) => j !== i) })}>
              ×
            </button>
          </div>
        ))}

        <button
          type="button"
          className="addfield"
          onClick={() => set({ fields: [...card.fields, { k: "", v: "" }] })}
        >
          ＋ 加一格
        </button>
      </div>

      <div className="cardfoot">
        <button type="button" className="btn" disabled={!card.name.trim() || busy} onClick={() => save("done")}>
          完成
        </button>
        {isNew && (
          <button
            type="button"
            className="btn ghost"
            disabled={!card.name.trim() || busy}
            onClick={() => save("again")}
          >
            完成 · 再建一个
          </button>
        )}
      </div>

      {!isNew && (
        <button type="button" className="danger" onClick={remove}>
          删除这张卡
        </button>
      )}
    </main>
  );
}
