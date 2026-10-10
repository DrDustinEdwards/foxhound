// The markdown "source" Carrel reads and writes for one blog post
// (job_cbe1b96107fc). Carrel sees one markdown document per post, so the post's
// non-body fields travel as a small front matter block. Every value is a JSON
// literal on one line, so the round trip is lossless and needs no YAML parser:
//
//   ---
//   title: "Why cards fail"
//   slug: "why-cards-fail"
//   excerpt: "..."
//   author: "Dustin Edwards"
//   tags: ["billing", "recovery"]
//   featured: false
//   ---
//   Body markdown.

export interface PostSource {
  title: string;
  slug: string | null;
  excerpt: string;
  author: string;
  tags: string[];
  featured: boolean;
  body: string;
}

export class SourceError extends Error {}

const FENCE = "---";

export function serializePostSource(post: PostSource): string {
  const lines = [
    FENCE,
    `title: ${JSON.stringify(post.title)}`,
    ...(post.slug ? [`slug: ${JSON.stringify(post.slug)}`] : []),
    `excerpt: ${JSON.stringify(post.excerpt)}`,
    `author: ${JSON.stringify(post.author)}`,
    `tags: ${JSON.stringify(post.tags)}`,
    `featured: ${JSON.stringify(post.featured)}`,
    FENCE,
  ];
  return `${lines.join("\n")}\n${post.body}`;
}

export function parsePostSource(source: string, defaults: { author: string }): PostSource {
  const text = source.replace(/\r\n/g, "\n");
  if (!text.startsWith(`${FENCE}\n`)) {
    throw new SourceError("The source must start with a front matter block (---).");
  }
  const end = text.indexOf(`\n${FENCE}\n`, FENCE.length);
  if (end === -1) throw new SourceError("The front matter block is not closed with ---.");

  const fields = new Map<string, unknown>();
  for (const line of text.slice(FENCE.length + 1, end).split("\n")) {
    if (line.trim() === "") continue;
    const match = /^([a-z]+): (.*)$/.exec(line);
    if (!match) throw new SourceError(`Front matter line not understood: ${line.slice(0, 60)}`);
    try {
      fields.set(match[1], JSON.parse(match[2]));
    } catch {
      throw new SourceError(`Front matter value for "${match[1]}" is not valid JSON.`);
    }
  }

  const str = (key: string, fallback: string | null): string | null => {
    const value = fields.get(key);
    if (value === undefined) return fallback;
    if (typeof value !== "string") throw new SourceError(`"${key}" must be a string.`);
    return value;
  };

  const title = str("title", null);
  if (!title || title.trim() === "") throw new SourceError('"title" is required.');

  const tags = fields.get("tags") ?? [];
  if (!Array.isArray(tags) || tags.some((t) => typeof t !== "string")) {
    throw new SourceError('"tags" must be a list of strings.');
  }
  const featured = fields.get("featured") ?? false;
  if (typeof featured !== "boolean") throw new SourceError('"featured" must be true or false.');

  return {
    title,
    slug: str("slug", null),
    excerpt: str("excerpt", "") ?? "",
    author: str("author", defaults.author) ?? defaults.author,
    tags: tags as string[],
    featured,
    body: text.slice(end + FENCE.length + 2),
  };
}
