"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import WorldTabs from "@/components/WorldTabs";
import { getWorld } from "@/lib/db";
import { World } from "@/lib/types";

export default function CharactersPage() {
  const params = useParams<{ id: string }>();
  const [world, setWorld] = useState<World | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      const w = await getWorld(params.id);
      setWorld(w || null);
      setLoading(false);
    })();
  }, [params.id]);

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

  const count = world.characters.length;

  return (
    <main className="page">
      <WorldTabs worldId={world.id} title={world.title} active="characters" />

      <div className="clist">
        {world.characters.map((c, i) => (
          <Link className="crow" href={`/world/${world.id}/character/${c.id}`} key={c.id}>
            <span className="face">
              {c.avatar ? <img src={c.avatar} alt="" /> : (c.name || "？").slice(0, 1)}
            </span>
            <div className="txt">
              <h4>
                {c.name || "未命名"}
                <i>{String(i + 1).padStart(2, "0")}</i>
              </h4>
              <p>
                {c.identity || "身份未定"}
                {c.speech ? (
                  <>
                    <br />
                    {c.speech}
                  </>
                ) : null}
              </p>
              <span className="vo">
                {c.voiceId ? (
                  <>
                    音色 ID · <em>{c.voiceId}</em>
                  </>
                ) : (
                  "默认音色"
                )}
              </span>
            </div>
            <u>›</u>
          </Link>
        ))}

        <Link className="crow add" href={`/world/${world.id}/character/new`}>
          <span className="face">＋</span>
          <div className="txt">
            <h4 style={{ color: "var(--ink-2)" }}>新建人物</h4>
            <p>贴一段原文，或者说个人名</p>
          </div>
          <u>›</u>
        </Link>
      </div>

      <div className="cfoot">
        {count ? `${count} 张 · 头像、音色、设定，点开就能改` : "还没有人物 · 头像、音色、设定，点开就能改"}
      </div>

      <footer className="colophon">
        <div className="rule" />
        <div className="act">
          <span className="aside">
            音色没填就用默认<em>服务商与 Key 在设置里</em>
          </span>
          <Link className="go" href={`/world/${world.id}/character/new`}>
            新建人物<u>→</u>
          </Link>
        </div>
      </footer>
    </main>
  );
}
