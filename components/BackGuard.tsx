"use client";

import { useEffect } from "react";

// 挡住系统侧滑返回：留一层占位历史，退回来就再补一层，页面不会滑走
export default function BackGuard() {
  useEffect(() => {
    const lock = () => {
      try {
        history.pushState({ guard: Date.now() }, "");
      } catch {
        /* 不支持就算了 */
      }
    };
    lock();
    window.addEventListener("popstate", lock);
    return () => window.removeEventListener("popstate", lock);
  }, []);

  return null;
}
