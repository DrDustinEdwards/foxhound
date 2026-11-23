// Stands in for postcss in the Worker bundle (vite.config.ts): sanitize-html calls it only for style attributes.
export function parse(): never {
  throw new Error("postcss is not bundled");
}
