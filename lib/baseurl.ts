// 把用户填的地址补成能直接拼 /models、/chat/completions 的基址。
// 中转站几乎都是 OpenAI 兼容接口，版本段是 /v1；少填这一段时请求会落到站点根路由，报的错还跟分组有关，很难查。
export function normalizeBaseUrl(raw: string): string {
  const u = (raw || "").trim().replace(/\/+$/, "");
  if (!u) return u;
  // 已经带版本段（/v1、/v1beta、/api/v1 等）就不再补
  if (/\/v\d+[a-z0-9]*$/i.test(u)) return u;
  return `${u}/v1`;
}
