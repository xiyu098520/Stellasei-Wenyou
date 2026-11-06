import { handleVoice } from "../../lib/api/voice";

export const onRequestPost = async (context: { request: Request }) => handleVoice(context.request);
