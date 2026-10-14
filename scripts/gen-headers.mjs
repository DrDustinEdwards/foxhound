#!/usr/bin/env node
// Writes public/_headers from the security header set the Worker applies
// (app/lib/http/header-set.ts, site-runtime's OWASP standard with Foxhound's
// overrides; J22, RULES.md 4.2). Static assets never reach the Worker, so the
// same set has to live in that file too; generating it means there is one
// source. test/static-headers.test.ts fails in CI if the committed file is not
// exactly what this writes.
//
// `--check` writes nothing and exits 1 on drift, for a local run.
//
// header-set.ts is loaded with Node's own TypeScript type stripping (Node 22.18
// and later; .nvmrc pins 26), which is why that module imports only the package.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { renderStaticHeadersFile } from "../app/lib/http/header-set.ts";

const target = fileURLToPath(new URL("../public/_headers", import.meta.url));
const wanted = renderStaticHeadersFile();

if (process.argv.includes("--check")) {
  const current = readFileSync(target, "utf8");
  if (current !== wanted) {
    console.error("gen-headers: public/_headers differs from app/lib/http/header-set.ts; run `npm run gen:headers`.");
    process.exit(1);
  }
  console.log("gen-headers: public/_headers matches the Worker's set.");
} else {
  writeFileSync(target, wanted);
  console.log("gen-headers: wrote public/_headers.");
}
