import Link from "next/link";

export default function WorldTabs({
  worldId,
  title,
  active,
}: {
  worldId: string;
  title: string;
  active: "play" | "setting" | "characters" | "favorites";
}) {
  return (
    <div className="topbar">
      <Link className="where" href="/">
        <u>‹</u>
        {title}
      </Link>
      <nav className="tabs">
        <Link className={active === "play" ? "on" : ""} href={`/world/?id=${worldId}`}>
          开演
        </Link>
        <Link className={active === "setting" ? "on" : ""} href={`/world/setting/?id=${worldId}`}>
          设定
        </Link>
        <Link className={active === "characters" ? "on" : ""} href={`/world/characters/?id=${worldId}`}>
          人物
        </Link>
        <Link className={active === "favorites" ? "on" : ""} href={`/world/favorites/?id=${worldId}`}>
          收藏
        </Link>
      </nav>
    </div>
  );
}
