import { pageCursor, readPageCursor } from "@dustinedwards/site-runtime/encoding";

import { type McpToolAnnotations, ToolInputError } from "./registry";

export type ToolArgs = Record<string, unknown>;

/** A tool's outputSchema: an object naming its top-level fields, `required` only those always present (a lookup that
 *  may come back empty is not required). Nested shapes are left open; the SDK checks each successful result against it. */
export function result(fields: string[], required: string[] = fields) {
  return {
    type: "object" as const,
    properties: Object.fromEntries(fields.map((field) => [field, {}])),
    required,
  };
}

export const READ: McpToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

export function stringArg(args: ToolArgs, name: string): string | null {
  const raw = args[name];
  return typeof raw === "string" && raw.length > 0 ? raw : null;
}

export function required(args: ToolArgs, name: string, from: string): string {
  const value = stringArg(args, name);
  if (value === null) throw new ToolInputError(`Missing required argument ${name}. ${from}`);
  return value;
}

//
// One shape everywhere: a list takes an optional `cursor` and answers `has_more` and `next_cursor` (null on the last
// page). The cursor is opaque, names its tool (a cursor from another list is refused with a sentence), and carries a
// position only: the account still comes from the key on every page.

export const CURSOR_PROPERTY = {
  type: "string",
  description: "Omit for the first page. To read on, pass next_cursor from the previous answer.",
} as const;

export function decodeOffsetCursor(tool: string, args: ToolArgs): number {
  const raw = args["cursor"];
  if (raw === undefined || raw === null || raw === "") return 1;
  const refusal = new ToolInputError(
    `That cursor was not issued by ${tool}. Omit cursor to start from the first page.`,
  );
  const p = typeof raw === "string" ? readPageCursor(tool, raw) : null;
  if (p === null || p < 1) throw refusal;
  return p;
}

export function pageInfo(tool: string, page: number, totalPages: number) {
  const hasMore = page < totalPages;
  return { has_more: hasMore, next_cursor: hasMore ? pageCursor(tool, page + 1) : null };
}

export function slicePage<T>(tool: string, rows: T[], page: number, pageSize: number) {
  const totalPages = Math.max(1, Math.ceil(rows.length / pageSize));
  const items = rows.slice((page - 1) * pageSize, page * pageSize);
  return { items, total: rows.length, ...pageInfo(tool, page, totalPages) };
}

/** Turn an apply result into a tool response, or a tool error carrying the form's own refusal string. */
export function applied<T>(
  result: { ok: true; fields: string[]; state: T } | { ok: false; error: string },
): { updated: string[]; state: T } {
  if (!result.ok) throw new ToolInputError(result.error);
  return { updated: result.fields, state: result.state };
}
