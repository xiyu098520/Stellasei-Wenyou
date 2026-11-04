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
        <Link className={active === "play" ? "on" : ""} href={`/world/${worldId}`}>
          开演
        </Link>
        <Link className={active === "setting" ? "on" : ""} href={`/world/${worldId}/setting`}>
          设定
        </Link>
        <Link className={active === "characters" ? "on" : ""} href={`/world/${worldId}/characters`}>
          人物
        </Link>
        <Link className={active === "favorites" ? "on" : ""} href={`/world/${worldId}/favorites`}>
          收藏
        </Link>
      </nav>
    </div>
  );
}
