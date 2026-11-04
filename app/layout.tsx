import type { Metadata, Viewport } from "next";
import "./globals.css";
import BackGuard from "@/components/BackGuard";

export const metadata: Metadata = {
  title: "文游",
  description: "给一个世界观，AI 演这个世界里的所有人。",
  manifest: "/manifest.webmanifest",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  viewportFit: "cover",
  themeColor: "#FCFAF6",
};

const SPLASH = [
  { href: "/splash/640x1136.png", media: "(device-width: 320px) and (device-height: 568px) and (-webkit-device-pixel-ratio: 2)" },
  { href: "/splash/750x1334.png", media: "(device-width: 375px) and (device-height: 667px) and (-webkit-device-pixel-ratio: 2)" },
  { href: "/splash/828x1792.png", media: "(device-width: 414px) and (device-height: 896px) and (-webkit-device-pixel-ratio: 2)" },
  { href: "/splash/1125x2436.png", media: "(device-width: 375px) and (device-height: 812px) and (-webkit-device-pixel-ratio: 3)" },
  { href: "/splash/1170x2532.png", media: "(device-width: 390px) and (device-height: 844px) and (-webkit-device-pixel-ratio: 3)" },
  { href: "/splash/1179x2556.png", media: "(device-width: 393px) and (device-height: 852px) and (-webkit-device-pixel-ratio: 3)" },
  { href: "/splash/1206x2622.png", media: "(device-width: 402px) and (device-height: 874px) and (-webkit-device-pixel-ratio: 3)" },
  { href: "/splash/1242x2208.png", media: "(device-width: 414px) and (device-height: 736px) and (-webkit-device-pixel-ratio: 3)" },
  { href: "/splash/1242x2688.png", media: "(device-width: 414px) and (device-height: 896px) and (-webkit-device-pixel-ratio: 3)" },
  { href: "/splash/1284x2778.png", media: "(device-width: 428px) and (device-height: 926px) and (-webkit-device-pixel-ratio: 3)" },
  { href: "/splash/1290x2796.png", media: "(device-width: 430px) and (device-height: 932px) and (-webkit-device-pixel-ratio: 3)" },
  { href: "/splash/1320x2868.png", media: "(device-width: 440px) and (device-height: 956px) and (-webkit-device-pixel-ratio: 3)" },
];

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <head>
        <style>{`html,body{background:#FCFAF6}
.boot{position:fixed;inset:0;z-index:99;background:#FCFAF6;pointer-events:none;animation:boot-out .28s ease .06s forwards}
@keyframes boot-out{to{opacity:0;visibility:hidden}}`}</style>
        <link rel="stylesheet" href="/fonts/kinghwa-oldsong.css" />
        <meta name="mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-title" content="文游" />
        <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
        {SPLASH.map((s) => (
          <link key={s.href} rel="apple-touch-startup-image" href={s.href} media={s.media} />
        ))}
      </head>
      <body>
        <BackGuard />
        <div className="boot" aria-hidden />
        <div className="app">
          {children}
          <div className="grain" aria-hidden />
        </div>
      </body>
    </html>
  );
}
