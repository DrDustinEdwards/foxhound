import type { Db } from "~/db";
import { pageCursor, readPageCursor } from "@dustinedwards/site-runtime/encoding";

export const ADMIN_API_PREFIX = "/api/admin/v1";
const PAGE_SIZE = 25;
export type Json = Record<string, unknown>;

export interface Caller {
  keyId: string;
  actorEmail: string;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export function page(url: URL, route: string): number {
  const raw = url.searchParams.get("cursor");
  if (!raw) return 1;
  const p = readPageCursor(route, raw);
  if (p !== null && p >= 1) return p;
  throw new ApiError(
    400,
    `That cursor was not issued by ${route}. Omit cursor to start from the first page.`,
  );
}

export function slice<T>(route: string, rows: T[], pageNumber: number) {
  const items = rows.slice((pageNumber - 1) * PAGE_SIZE, pageNumber * PAGE_SIZE);
  const hasMore = pageNumber * PAGE_SIZE < rows.length;
  return {
    items,
    total: rows.length,
    has_more: hasMore,
    next_cursor: hasMore ? pageCursor(route, pageNumber + 1) : null,
  };
}

interface RouteContext {
  db: Db;
  env: Env;
  caller: Caller;
  url: URL;
  params: string[];
  body: Json;
  now: Date;
}

type Handler = (ctx: RouteContext) => Promise<Json>;

export interface ApiRoute {
  method: "GET" | "POST";
  pattern: string;
  handler: Handler;
}
