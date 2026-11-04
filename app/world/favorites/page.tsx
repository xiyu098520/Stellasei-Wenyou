"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useRef, useState } from "react";
import WorldTabs from "@/components/WorldTabs";
import { deleteFavorite, getWorld, listFavorites, type Favorite } from "@/lib/db";
import { characterByName } from "@/lib/prompt";
import type { World } from "@/lib/types";

export default function FavoritesPage() {
  // 静态导出没有动态路由，世界 id 改从查询串读；useSearchParams 必须包在 Suspense 里
  return (
    <Suspense
      fallback={
        <main className="page">
          <div className="loading">正在翻开</div>
        </main>
      }
    >
      <Favorites />
    </Suspense>
  );
}

function Favorites() {
  const search = useSearchParams();
  const worldId = search.get("id") || "";
  const [world, setWorld] = useState<World | null>(null);
  const [items, setItems] = useState<Favorite[]>([]);
  const [loading, setLoading] = useState(true);
  const [playing, setPlaying] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const urlRef = useRef<string | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      const [w, favs] = await Promise.all([getWorld(worldId), listFavorites(worldId)]);
      if (!alive) return;
      setWorld(w || null);
      setItems(favs);
      setLoading(false);
    })();
    return () => {
      alive = false;
    };
  }, [worldId]);

  // 离开页面就把播放器收回，免得声音还在后台响
  useEffect(
    () => () => {
      audioRef.current?.pause();
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    },
    [],
  );

  function toggle(f: Favorite) {
    const el = audioRef.current ?? (audioRef.current = new Audio());
    if (playing === f.key) {
      el.pause();
      setPlaying(null);
      return;
    }
    el.pause();
    if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    const url = URL.createObjectURL(f.blob);
    urlRef.current = url;
    el.src = url;
    el.onended = () => setPlaying((p) => (p === f.key ? null : p));
    setPlaying(f.key);
    void el.play().catch(() => setPlaying(null));
  }

  async function remove(f: Favorite) {
    if (playing === f.key) {
      audioRef.current?.pause();
      setPlaying(null);
    }
    await deleteFavorite(f.key);
    setItems((list) => list.filter((x) => x.key !== f.key));
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

  return (
    <main className="page">
      <WorldTabs worldId={world.id} title={world.title} active="favorites" />
      <div className="story">
        {items.length === 0 ? (
          <p className="emptyhint">还没有收藏。长按台词旁边的播放键，就能把这句留在这里。</p>
        ) : (
          items.map((f) => {
            const c = characterByName(world, f.speaker);
            return (
              <div className="blk say" key={f.key}>
                <div className="sayer">
                  <span className="face">
                    {c?.avatar ? <img src={c.avatar} alt="" /> : (f.speaker || "？").slice(0, 1)}
                  </span>
                  <span className="who">{f.speaker || "某人"}</span>
                  <button
                    type="button"
                    className={playing === f.key ? "playbtn on" : "playbtn"}
                    onClick={() => toggle(f)}
                    aria-label={playing === f.key ? "停止" : "念这句"}
                  >
                    <svg viewBox="0 0 12 12" width="9" height="9" aria-hidden="true">
                      {playing === f.key ? (
                        <>
                          <rect x="3" y="2.4" width="1.7" height="7.2" rx=".6" fill="currentColor" />
                          <rect x="7.3" y="2.4" width="1.7" height="7.2" rx=".6" fill="currentColor" />
                        </>
                      ) : (
                        <path d="M3.4 1.9v8.2l7-4.1z" fill="currentColor" />
                      )}
                    </svg>
                  </button>
                  <button
                    type="button"
                    className="favdel"
                    onClick={() => void remove(f)}
                    aria-label="取消收藏"
                  >
                    移除
                  </button>
                </div>
                <p>{f.text}</p>
              </div>
            );
          })
        )}
      </div>
    </main>
  );
}
