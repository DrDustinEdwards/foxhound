import { getDocGuide } from "~/lib/marketing/docs-content";

import type { Route } from "./+types/page";

// Ported from legacy docs/{platform,audit,recovery,disputes,intelligence}/page.tsx
// (Phase 6 Pass 1), collapsed onto a single dynamic :slug route backed by
// app/lib/marketing/docs-content.ts instead of five separate route files.

export function loader({ params }: Route.LoaderArgs) {
  const guide = getDocGuide(params.slug);
  if (!guide) {
    throw new Response("Not found", { status: 404 });
  }
  return { guide };
}

export function meta({ loaderData }: Route.MetaArgs) {
  if (!loaderData) return [{ title: "Docs - Foxhound" }];
  return [
    { title: `${loaderData.guide.title} - Foxhound docs` },
    { name: "description", content: loaderData.guide.description },
  ];
}

export default function DocGuidePage({ loaderData }: Route.ComponentProps) {
  const { guide } = loaderData;

  return (
    <div>
      <div className="border-b border-border-sub px-4 py-16 text-center sm:px-8">
        <p className="font-mono text-micro uppercase tracking-wide text-text-tertiary">Docs</p>
        <h1 className="mt-3 text-display font-medium text-text">{guide.title}</h1>
        <p className="mx-auto mt-3 max-w-xl text-body text-text-secondary">{guide.description}</p>
      </div>

      <main className="mx-auto max-w-2xl px-4 py-16 sm:px-8">
        <div className="flex flex-col gap-10">
          {guide.sections.map((section) => (
            <section key={section.heading}>
              <h2 className="mb-3 text-title font-medium text-text">{section.heading}</h2>
              <div className="flex flex-col gap-3 text-body leading-relaxed text-text-secondary">
                {section.body.map((paragraph) => (
                  <p key={paragraph}>{paragraph}</p>
                ))}
              </div>
            </section>
          ))}
        </div>
      </main>
    </div>
  );
}
