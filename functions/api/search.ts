import { handleSearch } from "../../lib/api/search";

export const onRequestPost = async (context: { request: Request }) => handleSearch(context.request);
