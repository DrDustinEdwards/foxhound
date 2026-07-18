export function meta() {
  return [{ title: "Help - Foxhound" }];
}

const SECTIONS = [
  {
    title: "Recovery",
    body: "When a subscription payment fails, Foxhound classifies the decline and runs a silent retry before ever emailing your customer, so a payment that would have quietly gone through is never turned into a dunning email. Non-retryable declines (an expired card, a suspected fraud block) lead with the email carrying a hosted card-update link instead. Every step is visible on the payment's detail page under Recovery.",
  },
  {
    title: "Disputes",
    body: "When a chargeback comes in, Foxhound drafts the evidence response. Nothing is ever submitted automatically: you review the full draft, edit anything that needs it, and explicitly approve and sign before it goes to your card network. The confirmation always states the fee you'll be charged if the dispute resolves in your favor.",
  },
  {
    title: "Billing",
    body: "Foxhound is pay-on-lift: you are only charged a fee on a payment Foxhound actually recovered, once it has matured past the refund/dispute window. The Billing page renders every fee as a chain back to the specific action Foxhound took and the recovered payment it produced. Recoveries Stripe would have collected on its own (no Foxhound action involved) appear in the same ledger marked free.",
  },
  {
    title: "Team",
    body: "Invite teammates from Settings > Team. Foxhound is single-account: an invited teammate joins your one account, they cannot create or switch between separate accounts.",
  },
  {
    title: "Brand voice",
    body: "Set an optional voice description in Settings so recovery emails read like your business, not a template.",
  },
];

export default function Help() {
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6 px-4 py-8">
      <h1 className="text-title font-medium text-text">Help</h1>
      <div className="flex flex-col gap-4">
        {SECTIONS.map((section) => (
          <section key={section.title} className="rounded-lg border border-border bg-surface p-5">
            <h2 className="text-label font-semibold text-text">{section.title}</h2>
            <p className="mt-2 text-body text-text-secondary">{section.body}</p>
          </section>
        ))}
      </div>
      <p className="text-label text-text-tertiary">
        Something not covered here? Reach out to whoever invited you to Foxhound, or the account
        owner listed in Settings.
      </p>
    </div>
  );
}
