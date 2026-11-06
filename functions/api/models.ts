import { handleModels } from "../../lib/api/models";

export const onRequestPost = async (context: { request: Request }) => handleModels(context.request);
