"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { deleteWorld, getSaves, listWorlds, putWorld } from "@/lib/db";
import { chapterLabel, defaultBlocks, newId, Save, World } from "@/lib/types";
import { formatWhen } from "@/lib/format";
import { readImage } from "@/lib/image";
import { APP_VERSION } from "@/lib/version";

const TINTS = [
  "rgba(150,110,180,.22)",
  "rgba(63,94,140,.20)",
  "rgba(154,123,63,.20)",
  "rgba(196,102,124,.20)",
  "rgba(89,122,106,.20)",
];

export default function HomePage() {
  const router = useRouter();
  const [worlds, setWorlds] = useState<World[]>([]);
  const [saves, setSaves] = useState<Record<string, Save>>({});
  const [loading, setLoading] = useState(true);

  const [sheet, setSheet] = useState<"new" | "menu" | null>(null);
  const [menuId, setMenuId] = useState<string | null>(null);
  const [rename, setRename] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);

  const [title, setTitle] = useState("");
  const [hasSource, setHasSource] = useState(false);
  const [sourceTitle, setSourceTitle] = useState("");

  const [coverId, setCoverId] = useState<string | null>(null);
  const coverInput = useRef<HTMLInputElement>(null);
  const importInput = useRef<HTMLInputElement>(null);

  async function hardRefresh() {
    try {
      if ("caches" in window) {
        const keys = await caches.keys();
        await Promise.all(keys.map((k) => caches.delete(k)));
      }
      if ("serviceWorker" in navigator) {
        const regs = await navigator.serviceWorker.getRegistrations();
        await Promise.all(regs.map((r) => r.unregister()));
      }
    } catch {
      // 清不掉也照样重载
    }
    location.replace(`${location.pathname}?r=${Date.now()}`);
  }

  async function refresh() {
    const [ws, ss] = await Promise.all([listWorlds(), getSaves()]);
    setWorlds(ws);
    setSaves(Object.fromEntries(ss.map((s) => [s.worldId, s])));
    setLoading(false);
  }

  useEffect(() => {
    refresh();
  }, []);

  const menuWorld = worlds.find((w) => w.id === menuId) || null;

  function openMenu(id: string) {
    const w = worlds.find((x) => x.id === id);
    setMenuId(id);
    setRename(w?.title || "");
    setConfirmDelete(false);
    setSheet("menu");
  }

  async function createWorld() {
    const now = Date.now();
    const world: World = {
      id: newId(),
      version: 1,
      title: title.trim() || "未命名",
      hasSource,
      sourceTitle: hasSource ? sourceTitle.trim() : "",
      summary: "",
      blocks: defaultBlocks(),
      characters: [],
      createdAt: now,
      updatedAt: now,
    };
    await putWorld(world);
    router.push(`/world/setting/?id=${world.id}`);
  }

  async function onCover(file: File) {
    if (!coverId) return;
    const data = await readImage(file, 1000);
    const w = worlds.find((x) => x.id === coverId);
    if (!w) return;
    await putWorld({ ...w, cover: data });
    setCoverId(null);
    refresh();
  }

  async function saveRename() {
    if (!menuWorld) return;
    await putWorld({ ...menuWorld, title: rename.trim() || "未命名" });
    setSheet(null);
    refresh();
  }

  function exportScript(w: World) {
    // 封面太大，不带；人设、世界书是正文设定，一定要写进去
    const { cover, ...rest } = w;
    const blob = new Blob(
      [
        JSON.stringify(
          {
            format: "wenyou.script",
            ...rest,
            protagonist: w.protagonist || "",
            notes: w.notes || [],
          },
          null,
          2,
        ),
      ],
      { type: "application/json" },
    );
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${w.title || "剧本"}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  async function onImport(file: File) {
    const text = await file.text();
    try {
      const data = JSON.parse(text);
      if (!data || typeof data.title !== "string") throw new Error("bad file");
      const now = Date.now();
      const world: World = {
        id: newId(),
        version: 1,
        title: data.title,
        hasSource: Boolean(data.hasSource),
        sourceTitle: data.sourceTitle || "",
        summary: data.summary || "",
        // 人设和世界书也要跟着回来，不然导出再导入，「我」就空了
        protagonist: typeof data.protagonist === "string" ? data.protagonist : "",
        notes: Array.isArray(data.notes)
          ? (data.notes as { id?: string; title?: string; content?: string }[]).map((n) => ({
              id: String(n?.id || newId()),
              title: String(n?.title || ""),
              content: String(n?.content || ""),
            }))
          : [],
        blocks:
          Array.isArray(data.blocks) && data.blocks.length
            ? data.blocks.map((b: { id?: string; title?: string; content?: string }) => ({
                id: b.id || newId(),
                title: b.title || "未命名",
                content: b.content || "",
              }))
            : defaultBlocks(),
        characters: Array.isArray(data.characters)
          ? data.characters.map((c: Record<string, unknown>) => ({
              id: String(c.id || newId()),
              name: String(c.name || "未命名"),
              identity: String(c.identity || ""),
              speech: String(c.speech || ""),
              voiceId: String(c.voiceId || ""),
              avatar: typeof c.avatar === "string" ? c.avatar : undefined,
              fields: Array.isArray(c.fields)
                ? (c.fields as { k?: string; v?: string }[]).map((f) => ({
                    k: String(f.k || ""),
                    v: String(f.v || ""),
                  }))
                : [],
            }))
          : [],
        createdAt: now,
        updatedAt: now,
      };
      await putWorld(world);
      refresh();
    } catch {
      alert("这个文件读不出来。");
    }
  }

  async function removeWorld() {
    if (!menuId) return;
    await deleteWorld(menuId);
    setSheet(null);
    refresh();
  }

  return (
    <main className="page">
      <div className="mastline" />
      <div className="topline">
        <h1>我的世界</h1>
        <div className="right">
          <span>{String(worlds.length).padStart(2, "0")}</span>
          <button type="button" className="setbtn" onClick={() => importInput.current?.click()}>
            导入
          </button>
          <button type="button" className="setbtn" onClick={() => router.push("/settings/")}>
            设置
          </button>
          <button type="button" className="setbtn" onClick={hardRefresh}>
            刷新
          </button>
        </div>
      </div>

      <input
        ref={importInput}
        type="file"
        accept="application/json"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onImport(f);
          e.target.value = "";
        }}
      />
      <input
        ref={coverInput}
        type="file"
        accept="image/*"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onCover(f);
          e.target.value = "";
        }}
      />

      <div className="shelf">
        {loading && <div className="loading">正在翻开</div>}

        {!loading && worlds.length === 0 && (
          <p className="emptyhint">
            还没有世界。
            <br />
            给一个名字，剩下的边写边长。
          </p>
        )}

        {worlds.map((w, i) => {
          const save = saves[w.id];
          const label = save ? chapterLabel(save) : "序章";
          const turns = save ? save.messages.filter((m) => m.role === "user").length : 0;
          return (
            <article key={w.id} className="wcard" onClick={() => router.push(`/world/?id=${w.id}`)}>
              {w.cover ? (
                <img className="wcover" src={w.cover} alt="" />
              ) : (
                <div className="defcover" style={{ ["--tint" as string]: TINTS[i % TINTS.length] }} />
              )}
              <span className="widx">{String(i + 1).padStart(2, "0")}</span>
              <div className="shade" />
              <div className="tools" onClick={(e) => e.stopPropagation()}>
                <button
                  type="button"
                  onClick={() => {
                    setCoverId(w.id);
                    setTimeout(() => coverInput.current?.click(), 0);
                  }}
                >
                  换封面
                </button>
                <button type="button" onClick={() => openMenu(w.id)}>
                  ⋯
                </button>
              </div>
              <div className="winfo">
                <span className="src">
                  {w.hasSource && w.sourceTitle ? `原著 · ${w.sourceTitle}` : "原创 · 无原著"}
                </span>
                <h3>{w.title}</h3>
                <div className="wline">
                  <span>
                    {turns === 0 ? "还没有开始" : label}
                    <i>·</i>
                    {turns} 回合
                    {turns > 0 && save ? (
                      <>
                        <i>·</i>
                        {formatWhen(save.updatedAt)}
                      </>
                    ) : null}
                  </span>
                  <span className="faces">
                    {w.characters.slice(0, 3).map((c) => (
                      <b key={c.id}>{c.name.slice(0, 1)}</b>
                    ))}
                  </span>
                </div>
              </div>
            </article>
          );
        })}

        <button
          type="button"
          className="newline"
          onClick={() => {
            setTitle("");
            setHasSource(false);
            setSourceTitle("");
            setSheet("new");
          }}
        >
          <u>＋</u>开一个新世界
        </button>
      </div>

      <div className="verline">{APP_VERSION}</div>

      {sheet === "new" && (
        <div className="mask" onClick={() => setSheet(null)}>
          <div className="sheet" onClick={(e) => e.stopPropagation()}>
            <h2>开一个新世界</h2>
            <p className="sub">只有两格。设定进去再写。</p>

            <div className="field">
              <label>名字</label>
              <input
                className="inp"
                value={title}
                placeholder="比如 星球学院"
                onChange={(e) => setTitle(e.target.value)}
              />
            </div>

            <div className="field">
              <label>有没有原著</label>
              <div className="seg">
                <button type="button" className={!hasSource ? "on" : ""} onClick={() => setHasSource(false)}>
                  原创
                </button>
                <button type="button" className={hasSource ? "on" : ""} onClick={() => setHasSource(true)}>
                  有原著
                </button>
              </div>
            </div>

            {hasSource && (
              <div className="field">
                <label>作品名</label>
                <input
                  className="inp"
                  value={sourceTitle}
                  placeholder="比如 崩坏：星穹铁道"
                  onChange={(e) => setSourceTitle(e.target.value)}
                />
              </div>
            )}

            <div className="sheetact">
              <button type="button" className="btn" disabled={!title.trim()} onClick={createWorld}>
                开始
              </button>
              <button type="button" className="cancel" onClick={() => setSheet(null)}>
                取消
              </button>
            </div>
            <div className="sheetver">{APP_VERSION}</div>
          </div>
        </div>
      )}

      {sheet === "menu" && menuWorld && (
        <div className="mask" onClick={() => setSheet(null)}>
          <div className="sheet" onClick={(e) => e.stopPropagation()}>
            <h2>这个世界</h2>
            <div className="field">
              <label>名字</label>
              <input className="inp" value={rename} onChange={(e) => setRename(e.target.value)} />
            </div>

            <div className="sheetact">
              <button type="button" className="btn" onClick={saveRename}>
                存下
              </button>
              <button type="button" className="cancel" onClick={() => setSheet(null)}>
                取消
              </button>
            </div>

            <div className="colophon" style={{ marginTop: 22 }}>
              <div className="rule" />
              <div className="act" style={{ marginTop: 12 }}>
                <button
                  type="button"
                  className="aside"
                  style={{ fontSize: 11, letterSpacing: ".1em" }}
                  onClick={() => exportScript(menuWorld)}
                >
                  导出剧本
                </button>
                {!confirmDelete ? (
                  <button
                    type="button"
                    className="go"
                    style={{ fontSize: 11, letterSpacing: ".1em", color: "var(--seal)" }}
                    onClick={() => setConfirmDelete(true)}
                  >
                    删除
                  </button>
                ) : (
                  <button
                    type="button"
                    className="go"
                    style={{ fontSize: 11, letterSpacing: ".1em", color: "var(--seal)" }}
                    onClick={removeWorld}
                  >
                    再点一次，真的删掉
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
