/**
 * The words of an email block. Capsomer 0.72 lets a paragraph hold lines and bold runs
 * (`string | (string | { bold })[][]`), so a block's `text` is no longer always a string.
 */
type Words = string | readonly (readonly (string | { bold: string })[])[] | undefined;

export type WordsBlock = { type?: string; text?: unknown; label?: string; url?: string };

export function blockText(block: WordsBlock): string {
  const text = block.text as Words;
  if (typeof text === "string") return text;
  if (!Array.isArray(text)) return "";
  return (text as readonly (readonly (string | { bold: string })[])[])
    .map((line) => line.map((run) => (typeof run === "string" ? run : run.bold)).join(""))
    .join("\n");
}
