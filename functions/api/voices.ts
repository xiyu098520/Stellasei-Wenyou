import { handleVoices } from "../../lib/api/voices";

export const onRequestPost = async (context: { request: Request }) => handleVoices(context.request);
