import type { RequestHandler } from './$types';
import { handleStatic } from '$lib/server/office';

export const GET: RequestHandler = (event) => handleStatic(event.params.path);
export const HEAD: RequestHandler = async (event) => {
  const res = await handleStatic(event.params.path);
  return new Response(null, { status: res.status, headers: res.headers });
};
