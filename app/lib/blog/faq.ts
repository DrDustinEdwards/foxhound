// The :::faq block's question and answer pairs, read straight from a post's
// markdown. Pure, so the post page builds its FAQPage JSON-LD from the body
// without rendering it, and the render pack draws the same pairs.
//
// Moved unchanged from the old renderer (markdown.server.ts, J19), which ported
// it from Recova lib/markdown.ts (blob 62a2e55c).

export interface FaqPair {
  q: string;
  a: string;
}

/** The pairs in one block's raw text: "Q:" opens a question, "A:" its answer, and
 *  later lines continue the answer. A question with no answer is dropped. */
export function parseFaqPairs(content: string): FaqPair[] {
  const pairs: FaqPair[] = [];
  let currentQ: string | null = null;
  let currentA: string[] = [];

  function flush() {
    if (currentQ && currentA.length > 0) {
      pairs.push({ q: currentQ.trim(), a: currentA.join(" ").trim() });
    }
    currentQ = null;
    currentA = [];
  }

  for (const raw of content.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("Q:")) {
      flush();
      currentQ = line.slice(2).trim();
    } else if (line.startsWith("A:")) {
      currentA = [line.slice(2).trim()];
    } else if (line === "") {
      // blank, ignore
    } else if (currentA.length > 0) {
      currentA.push(line);
    }
  }
  flush();
  return pairs;
}

/** Every :::faq block in a body, flattened. [] for a body with none. */
export function extractFaqPairs(body: string): Array<{ question: string; answer: string }> {
  const pairs: Array<{ question: string; answer: string }> = [];
  const blockRe = /^:::faq(?:\[[^\]]*\])?\n([\s\S]*?)\n:::$/gm;
  let m: RegExpExecArray | null;
  while ((m = blockRe.exec(body)) !== null) {
    for (const p of parseFaqPairs(m[1])) {
      pairs.push({ question: p.q, answer: p.a });
    }
  }
  return pairs;
}
