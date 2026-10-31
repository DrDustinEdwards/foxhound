#!/usr/bin/env node
// Writes public/_headers from the security header set the Worker applies
// (app/lib/http/header-set.ts, through site-runtime's headersFile). `npm run
// build` runs it first, so the deployed file cannot drift; the committed copy is
// what devkit's family check reads (run this after changing the set).
//
// header-set.ts is loaded with Node's own TypeScript type stripping (Node 22.18
// and later; .nvmrc pins 26), which is why that module imports only packages.
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { renderStaticHeadersFile } from "../app/lib/http/header-set.ts";

writeFileSync(fileURLToPath(new URL("../public/_headers", import.meta.url)), renderStaticHeadersFile());
