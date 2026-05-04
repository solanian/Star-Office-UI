import type { RequestHandler } from './$types';
import { handlePath } from '$lib/server/office';

export const GET: RequestHandler = (event) => handlePath(event, '');
