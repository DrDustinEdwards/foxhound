// Shared column helpers for every schema module (conventions in index.ts).
import { integer, text } from "drizzle-orm/sqlite-core";

export const id = () => text("id").primaryKey().$defaultFn(() => crypto.randomUUID());
export const ts = (name: string) => integer(name, { mode: "timestamp_ms" });
export const bool = (name: string) => integer(name, { mode: "boolean" });
export function json<T = unknown>(name: string) {
  return text(name, { mode: "json" }).$type<T>();
}
