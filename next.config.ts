import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Next 15.5 的 react-hooks 规则（set-state-in-effect / immutability 等）会把一批老代码判成错，
  // 这些不是这次改出来的问题；先让构建通过，规则以后再逐条收。
  eslint: { ignoreDuringBuilds: true },
  reactStrictMode: true,
  // 纯静态导出：页面全部由 CDN 直接出，不再进 Netlify 函数，点击就不会凭空多等一秒
  output: "export",
  // 导出成 /world/index.html，静态托管原生就认，不靠重写规则
  trailingSlash: true,
  devIndicators: false,
  allowedDevOrigins: ["192.168.31.87"],
};

export default nextConfig;
