import { handleVoiceModels } from "../../lib/api/voicemodels";

export const onRequestPost = async (context: { request: Request }) => handleVoiceModels(context.request);
