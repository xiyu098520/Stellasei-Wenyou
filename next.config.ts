import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // 纯静态导出：页面全部由 CDN 直接出，不再进 Netlify 函数，点击就不会凭空多等一秒
  output: "export",
  // 导出成 /world/index.html，静态托管原生就认，不靠重写规则
  trailingSlash: true,
  devIndicators: false,
  allowedDevOrigins: ["192.168.31.87"],
};

export default nextConfig;
