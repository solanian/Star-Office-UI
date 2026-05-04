import type { RequestHandler } from './$types';
import { handlePath } from '$lib/server/office';

export const GET: RequestHandler = (event) => handlePath(event, event.params.path);
export const POST: RequestHandler = (event) => handlePath(event, event.params.path);
export const HEAD: RequestHandler = async (event) => {
  const res = await handlePath(event, event.params.path);
  return new Response(null, { status: res.status, headers: res.headers });
};
