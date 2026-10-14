import { Link } from "react-router";

import type { DocBlock, DocInline, DocRich } from "~/lib/marketing/docs-content";

import { DocWidget } from "./doc-widgets";

// Legacy's docs block vocabulary, at legacy's treatment on Foxhound's tokens.
//
// WHERE IT CAME FROM, and it is not where ruling 325 said. The sixteen files in
// legacy `components/docs/` are PREVIEW widgets (pills, table previews, sequence
// timelines) that the guides embed as illustrations. The prose vocabulary is
// defined INLINE at the bottom of each guide page: `app/(marketing)/docs/
// platform/page.tsx` (blob `2b69517b`, 20,507 bytes) and `.../recovery/page.tsx`
// (blob `6166a6be`, 23,209 bytes) each declare their own Part, H3, P, Note, Tip,
// Steps, Step, List, Item, Code, Strong and RelLink, byte-identical between the
// two files. So this is one shared module rather than a copy per guide, which is
// the one structural divergence and costs no treatment.
//
// THE TYPE SCALE IS SUBSTITUTED, NOT CHANGED (session 37's precedent). Legacy
// writes `text-[0.9375rem]` and `text-[0.8125rem]`; those are exactly
// `--text-item-title` and `--text-label` in app.css, and check-tokens forbids
// raw sizes anyway. `flex-shrink-0` becomes `shrink-0`, the Tailwind v4 spelling
// of the identical rule.

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
  // RelLink. An in-app path routes through Link so the marketing shell is not
  // torn down; anything else (a mailto, an external doc) is a plain anchor,
  // which is what legacy does for its support address.
  const className = "text-brand-text underline underline-offset-2 hover:text-brand";
  return inline.to.startsWith("/") ? (
    <Link to={inline.to} className={className}>
      {inline.link}
    </Link>
  ) : (
    <a href={inline.to} className={className}>
      {inline.link}
    </a>
  );
}

/** A run of inline nodes, or a plain string. The string form is what every
 *  pre-existing section uses, and it renders through the same path. */
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

function Block({ block }: { block: DocBlock }) {
  if (typeof block === "string") {
    return <p className="mb-4 text-item-title leading-relaxed text-text-secondary">{block}</p>;
  }

  switch (block.kind) {
    case "p":
      return (
        <p className="mb-4 text-item-title leading-relaxed text-text-secondary">
          <Rich content={block.body} />
        </p>
      );

    case "h3":
      return <h3 className="mb-3 mt-8 text-item-title font-medium text-text">{block.text}</h3>;

    case "note":
      return (
        <div className="my-4 border-l-2 border-border pl-4 text-label leading-relaxed text-text-secondary">
          <span className="font-medium text-text">Note.</span> <Rich content={block.body} />
        </div>
      );

    case "tip":
      return (
        <div className="my-4 border-l-2 border-brand pl-4 text-label leading-relaxed text-text-secondary">
          <span className="font-medium text-text">Tip.</span> <Rich content={block.body} />
        </div>
      );

    case "steps":
      return (
        <ol className="my-4 space-y-3">
          {block.items.map((item, i) => (
            <li
              key={i}
              className="flex gap-3 text-item-title leading-relaxed text-text-secondary"
            >
              {/* Legacy passes the number in as a literal zero-padded string on
                  every Step. Deriving it from the index means a step cannot be
                  inserted without renumbering the ones after it, which legacy's
                  hand-written form allows and nobody wants. */}
              <span className="shrink-0 font-mono text-brand-text">
                {String(i + 1).padStart(2, "0")}
              </span>
              <span>
                <Rich content={item} />
              </span>
            </li>
          ))}
        </ol>
      );

    case "list":
      return (
        <ul className="my-4 list-inside list-disc space-y-2 text-item-title leading-relaxed text-text-secondary">
          {block.items.map((item, i) => (
            <li key={i}>
              <Rich content={item} />
            </li>
          ))}
        </ul>
      );

    // A PREVIEW WIDGET, ruled by the session 65 walk. It takes no data and no
    // loader: every one either draws a fixed picture or derives its content from
    // a compile-time constant the engine already owns.
    case "widget":
      return <DocWidget name={block.name} />;

    case "table":
      return (
        <div className="my-6 overflow-x-auto">
          <table className="w-full text-label">
            <thead>
              <tr className="border-b border-border">
                {block.columns.map((column) => (
                  <th key={column} className="py-2 pr-4 text-left font-medium text-text">
                    {column}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="text-text-secondary">
              {block.rows.map((row, i) => (
                <tr key={i} className="border-b border-border">
                  {row.map((cell, j) => (
                    <td key={j} className="py-2 pr-4">
                      <Rich content={cell} />
                    </td>
                  ))}
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
