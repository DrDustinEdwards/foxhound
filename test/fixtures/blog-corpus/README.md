# Blog render corpus (J19)

Sample post bodies for test/blog-render-corpus-j19.test.ts, which renders each one through the renderer Foxhound used before J19
(test/support/render-before.ts) and through Prelum with Foxhound's render pack, and compares the two.

The bodies are written for the test, not copied from the live blog: the production corpus lives in D1 and is not in the repo. Each
one exercises the shapes the live posts carry (BLOG-EDITOR-COMPARISON.md in Capsid measured `::postlink` in 45 of 46 posts,
`:::diagram` in 8, tables in 5, inline code in 27) plus the prose the new parser could misread: dollar amounts, colons, headings
with punctuation. `published.json` is the set of posts a `::postlink` can resolve to.

To compare the real corpus, export it read-only and point the test at the file:

    npx wrangler d1 execute foxhound --remote --json --command "SELECT slug, title, excerpt, body, published FROM blog_posts" > corpus.json
    BLOG_CORPUS=corpus.json npx vitest run test/blog-render-corpus-j19.test.ts
