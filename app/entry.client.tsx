// The React entry, as React Router's default, with the page started first (site-runtime ./page-client): the Trusted
// Types default policy and INP reporting. /site.js starts it too; only the first call does anything.
import { startPage } from "@dustinedwards/site-runtime/page-client";
import { startTransition, StrictMode } from "react";
import { hydrateRoot } from "react-dom/client";
import { HydratedRouter } from "react-router/dom";

startPage();

startTransition(() => {
  hydrateRoot(
    document,
    <StrictMode>
      <HydratedRouter />
    </StrictMode>,
  );
});
