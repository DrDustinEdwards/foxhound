#!/usr/bin/env node
// Warn-only page weight report (job_30ab4e0e8702, no-bloat plan).
//
// Reads the React Router client manifest from build/client and prints, for
// every route that renders a page, the gzip bytes of the JS and CSS a first
// load of that URL downloads: the client entry, then every route module from
// root down to the leaf, with each one's imports and stylesheets, each file
// counted once. Run it after `npm run build`.
//
// It REPORTS and never blocks: it exits 0 whatever the weight, and a route over
// the budget gets a GitHub `::warning::` line so it shows on the PR without
// failing the run. The one non-zero exit is a missing build, because a report
// that read nothing must not look like a clean one.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

// Warn above this many gzip bytes per route. Set 2026-10-09 about 10% above the
// heaviest route measured that day (145.3 kB, see docs/research/baseline.md), so growth
// past today's ceiling is what gets flagged.
const BUDGET_GZIP_BYTES = 160_000;

const ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const CLIENT = resolve(ROOT, "build/client");
const ASSETS = resolve(CLIENT, "assets");

const manifestFile = existsSync(ASSETS)
  ? readdirSync(ASSETS).find((name) => /^manifest-[\w-]+\.js$/.test(name))
  : undefined;
if (!manifestFile) {
  console.error("report-page-weight: no build/client/assets/manifest-*.js. Run `npm run build` first.");
  process.exit(1);
}

const source = readFileSync(resolve(ASSETS, manifestFile), "utf8");
const json = source.slice(source.indexOf("{"), source.lastIndexOf("}") + 1);
const manifest = JSON.parse(json);

const gzipCache = new Map();
function gzipBytes(assetPath) {
  if (!gzipCache.has(assetPath)) {
    const file = resolve(CLIENT, `.${assetPath}`);
    gzipCache.set(assetPath, existsSync(file) ? gzipSync(readFileSync(file), { level: 9 }).length : 0);
  }
  return gzipCache.get(assetPath);
}

const routes = manifest.routes;
function chain(id) {
  const out = [];
  for (let route = routes[id]; route; route = route.parentId ? routes[route.parentId] : undefined) {
    out.unshift(route);
  }
  return out;
}

function urlOf(id) {
  const parts = chain(id)
    .map((route) => route.path ?? "")
    .filter((part) => part !== "");
  return `/${parts.join("/")}`;
}

const rows = [];
for (const [id, route] of Object.entries(routes)) {
  // Layouts and resource routes are not pages a visitor lands on.
  if (!route.hasDefaultExport) continue;
  if (Object.values(routes).some((other) => other.parentId === id)) continue;

  const files = new Set([manifest.entry.module, ...manifest.entry.imports, ...manifest.entry.css]);
  for (const step of chain(id)) {
    files.add(step.module);
    for (const file of step.imports ?? []) files.add(file);
    for (const file of step.css ?? []) files.add(file);
  }
  let js = 0;
  let css = 0;
  for (const file of files) {
    if (file.endsWith(".css")) css += gzipBytes(file);
    else js += gzipBytes(file);
  }
  rows.push({ id, url: urlOf(id), js, css, total: js + css, files: files.size });
}

rows.sort((a, b) => b.total - a.total);

const kb = (bytes) => `${(bytes / 1000).toFixed(1)} kB`;
console.log(`Page weight per route, gzip (budget ${kb(BUDGET_GZIP_BYTES)}, warn only)\n`);
console.log("| Route | JS | CSS | Total | Files |");
console.log("|-------|----|-----|-------|-------|");
for (const row of rows) {
  console.log(`| ${row.url} | ${kb(row.js)} | ${kb(row.css)} | ${kb(row.total)} | ${row.files} |`);
}

const over = rows.filter((row) => row.total > BUDGET_GZIP_BYTES);
for (const row of over) {
  console.log(
    `::warning title=Page weight::${row.url} loads ${kb(row.total)} gzip, over the ${kb(BUDGET_GZIP_BYTES)} budget`,
  );
}
const totals = rows.map((row) => row.total);
const median = totals.length ? [...totals].sort((a, b) => a - b)[Math.floor(totals.length / 2)] : 0;
console.log(
  `\n${rows.length} page routes; heaviest ${kb(totals[0] ?? 0)}, median ${kb(median)}; ${over.length} over budget.`,
);
