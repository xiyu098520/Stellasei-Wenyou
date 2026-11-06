import { handleChat } from "../../lib/api/chat";

// Cloudflare Pages Functions：路径 functions/api/chat.ts 对应 /api/chat，前端代码不用改
export const onRequestPost = async (context: { request: Request }) => handleChat(context.request);
