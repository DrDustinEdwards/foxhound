import { Link } from "react-router";

import type { DocBlock, DocInline, DocRich } from "~/lib/marketing/docs-content";

import { DocWidget } from "./doc-widgets";
import { HealthScoreBadge } from "./health-score-badge";

// Recova's docs block vocabulary, on Capsomer's parts (J73, Q12).
//
// WHERE IT CAME FROM. Recova defines its prose vocabulary INLINE at the bottom
// of each guide page (`app/(marketing)/docs/platform/page.tsx`, blob `2b69517b`,
// and the other four): Part, H3, P, Note, Tip, Steps, Step, List, Item, Code,
// Strong and RelLink, the same in every file. This is one shared module rather
// than a copy per guide.
//
// LOOK IS CAPSOMER'S, CONTENT AND ORDER RECOVA'S. The reference table is
// Capsomer's table (a labelled scroll region, so a wide table is a keyboard
// stop). Note and Tip are Recova's callout: a 2px rule at the left (amber for
// a tip, the border colour for a note) beside 13px secondary text, a plain
// paragraph so nothing is announced as an interruption.
//
// TEXT IS AT RECOVA'S SIZES: 0.9375rem for body and H3, 0.8125rem for callouts
// and tables, through the named type tokens in app.css.

/** Amber, underlined: Recova's RelLink, in the accent text the 2026-10-13 tokens
 *  set. */
const LINK = "text-accent-text underline underline-offset-2 hover:opacity-80";

function InlineRun({ inline }: { inline: DocInline }) {
  if (typeof inline === "string") return <>{inline}</>;
  if ("code" in inline) {
    return (
      <code className="rounded border border-border bg-surface px-1.5 py-0.5 font-mono text-label">
        {inline.code}
      </code>
    );
  }
  if ("strong" in inline) {
    return <strong className="font-medium text-text">{inline.strong}</strong>;
  }
  if ("mono" in inline) {
    return <span className="font-mono">{inline.mono}</span>;
  }
  // Recova's HealthScoreBadge inside the thresholds paragraph, banded by the
  // engine's healthScoreBand.
  if ("badge" in inline) {
    return <HealthScoreBadge score={inline.badge} />;
  }
  // An in-app path routes through Link so the marketing shell is not torn down;
  // anything else is a plain anchor.
  return inline.to.startsWith("/") ? (
    <Link to={inline.to} className={LINK}>
      {inline.link}
    </Link>
  ) : (
    <a href={inline.to} className={LINK}>
      {inline.link}
    </a>
  );
}

/** A run of inline nodes, or a plain string. */
function Rich({ content }: { content: DocRich }) {
  if (typeof content === "string") return <>{content}</>;
  return (
    <>
      {content.map((inline, i) => (
        <InlineRun key={i} inline={inline} />
      ))}
    </>
  );
}

const P = "mb-4 text-subhead leading-relaxed text-text-secondary";

/** Recova's note: a 2px rule down the left, amber for the one that matters
 *  (info), the plain border otherwise, read in the flow. */
function Callout({ tone, word, body }: { tone: "neutral" | "info"; word: string; body: DocRich }) {
  return (
    <p
      className={`my-4 border-l-2 pl-4 text-label leading-relaxed text-text-secondary ${
        tone === "info" ? "border-brand" : "border-border"
      }`}
    >
      <span className="font-medium text-text">{word}</span> <Rich content={body} />
    </p>
  );
}

function Block({ block }: { block: DocBlock }) {
  if (typeof block === "string") {
    return <p className={P}>{block}</p>;
  }

  switch (block.kind) {
    case "p":
      return (
        <p className={P}>
          <Rich content={block.body} />
        </p>
      );

    case "h3":
      return <h3 className="mb-3 mt-8 text-item-title font-medium text-text">{block.text}</h3>;

    case "note":
      return <Callout tone="neutral" word="Note." body={block.body} />;

    case "tip":
      return <Callout tone="info" word="Tip." body={block.body} />;

    case "steps":
      return (
        <ol className="my-4 space-y-3">
          {block.items.map((item, i) => (
            <li key={i} className="flex gap-3 text-subhead leading-relaxed text-text-secondary">
              {/* Recova hand-writes "01", "02"; derived here so a step cannot
                  be inserted without its number following. */}
              <span className="shrink-0 font-mono text-accent-text">{String(i + 1).padStart(2, "0")}</span>
              <span>
                <Rich content={item} />
              </span>
            </li>
          ))}
        </ol>
      );

    case "list":
      return (
        <ul className="my-4 list-inside list-disc space-y-2 text-subhead leading-relaxed text-text-secondary">
          {block.items.map((item, i) => (
            <li key={i}>
              <Rich content={item} />
            </li>
          ))}
        </ul>
      );

    // A preview widget: no data and no loader; each one draws a fixed picture
    // or derives its content from a constant the engine owns.
    case "widget":
      return <DocWidget name={block.name} />;

    case "table":
      return (
        <div
          className="cap-table-wrap my-6"
          data-cap="table"
          role="region"
          aria-label={block.label}
          tabIndex={0}
        >
          <table className="cap-table">
            <thead>
              <tr>
                {block.columns.map((column) => (
                  <th key={column} scope="col">
                    {column}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, i) => (
                <tr key={i}>
                  {row.map((cell, j) =>
                    j === 0 ? (
                      <th key={j} scope="row">
                        <Rich content={cell} />
                      </th>
                    ) : (
                      <td key={j}>
                        <Rich content={cell} />
                      </td>
                    ),
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
  }
}

export function DocBlocks({ blocks }: { blocks: DocBlock[] }) {
  return (
    <>
      {blocks.map((block, i) => (
        <Block key={i} block={block} />
      ))}
    </>
  );
}
