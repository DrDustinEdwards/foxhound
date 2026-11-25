import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createMemoryRouter, RouterProvider } from "react-router";
import { describe, expect, it, vi } from "vitest";

import { finalizeCardUpdateSession } from "~/lib/card-update/service";
import { signCardUpdateToken, verifyCardUpdateToken } from "~/lib/card-update/token";
import CardUpdate, {
  resolveConnectionForFailedPayment,
  type ConnectionCandidate,
} from "~/routes/utility/card-update";

// Capsomer's real Button, wrapped only to capture the click handler its <button> carries.
const clicks = vi.hoisted(() => ({ handlers: [] as ((e: unknown) => void)[] }));
vi.mock("capsomer/react/button", async (importOriginal) => {
  const real = await importOriginal<typeof import("capsomer/react/button")>();
  function Button(props: Parameters<typeof real.Button>[0]) {
    const el = real.Button(props) as ReactElement<{
      onClick?: (e: unknown) => void;
      children?: unknown;
    }>;
    const btn =
      el.type === "button"
        ? el
        : (el.props.children as ReactElement<{ onClick?: (e: unknown) => void }>[])[0];
    if (btn.props.onClick) clicks.handlers.push(btn.props.onClick);
    return el;
  }
  return { ...real, Button };
});

const stripe = vi.hoisted(() => ({
  session: {} as Record<string, unknown>,
  updated: [] as string[],
}));
vi.mock("~/lib/stripe/client", () => ({
  getConnectedStripe: () => ({
    checkout: { sessions: { retrieve: async () => stripe.session } },
    customers: {
      update: async (id: string) => {
        stripe.updated.push(id);
      },
    },
  }),
}));

// 64 hex chars = 32-byte HMAC key.
const env = { ENCRYPTION_KEY: "a".repeat(64) } as unknown as Env;

describe("card-update token sign/verify", () => {
  it("rejects a well-formed token signed with a different key", async () => {
    const otherEnv = { ENCRYPTION_KEY: "b".repeat(64) } as unknown as Env;
    const token = await signCardUpdateToken(otherEnv, {
      failedPaymentId: "fp_1",
      accountId: "acc_1",
    });
    expect(await verifyCardUpdateToken(env, token)).toBeNull();
  });
});

describe("resolveConnectionForFailedPayment", () => {
  const connA: ConnectionCandidate = { id: "conn_a", stripeAccessToken: "enc_a" };
  const connB: ConnectionCandidate = { id: "conn_b", stripeAccessToken: "enc_b" };

  it("picks the connection tied to the failed payment when the account has more than one active connection", () => {
    expect(resolveConnectionForFailedPayment([connA, connB], "conn_b")).toEqual(connB);
  });

  it("falls back to the single active connection for older rows with no stripe_connection_id recorded", () => {
    expect(resolveConnectionForFailedPayment([connA], null)).toEqual(connA);
  });

  it("never guesses among multiple connections when stripe_connection_id is null", () => {
    expect(resolveConnectionForFailedPayment([connA, connB], null)).toBeNull();
  });
});

describe("finalizeCardUpdateSession: only the session this link made", () => {
  // session_id is a URL parameter: only the setup session this link made may record a billable card_update.
  const link = { accessToken: "tok", sessionId: "cs_1", customerId: "cus_link", linkRef: "fp_1" };
  const made = {
    mode: "setup",
    status: "complete",
    customer: "cus_link",
    client_reference_id: "fp_1",
    setup_intent: { payment_method: "pm_new" },
  };

  it.each([
    ["another customer's session", { customer: "cus_other" }],
    ["a session made for another link", { client_reference_id: "fp_2" }],
    ["a session with no link reference", { client_reference_id: null }],
    ["a payment-mode session", { mode: "payment" }],
  ])("refuses %s and changes nothing", async (_name, over) => {
    stripe.session = { ...made, ...over };
    stripe.updated = [];
    expect((await finalizeCardUpdateSession(link)).ok).toBe(false);
    expect(stripe.updated).toEqual([]);
  });

  it("accepts the session this link made", async () => {
    stripe.session = made;
    stripe.updated = [];
    expect(await finalizeCardUpdateSession(link)).toEqual({ ok: true });
    expect(stripe.updated).toEqual(["cus_link"]);
  });
});

type Props = Parameters<typeof CardUpdate>[0];
type LoaderData = Props["loaderData"];

const READY: LoaderData = { state: "ready", amountCents: 9900, currency: "usd" };
const RESUBSCRIBE: LoaderData = { state: "resubscribe", planName: "Pro" };

/** Render the page while a POST to its own action is in flight (the action never settles). */
async function renderSubmitting(loaderData: LoaderData): Promise<string> {
  const props = { loaderData, params: { token: "t" }, matches: [] } as unknown as Props;
  const router = createMemoryRouter(
    [{ path: "*", element: createElement(CardUpdate, props), action: () => new Promise(() => {}) }],
    { initialEntries: ["/p/t"] },
  );
  void router.navigate("/p/t", { formMethod: "post", formData: new FormData() });
  for (let i = 0; i < 20 && router.state.navigation.state !== "submitting"; i++)
    await Promise.resolve();
  expect(router.state.navigation.state, "the POST is in flight").toBe("submitting");
  return renderToStaticMarkup(createElement(RouterProvider, { router }));
}

describe("the pay button while the Checkout redirect starts", () => {
  for (const [name, state] of [
    ["recovery", READY],
    ["resubscribe", RESUBSCRIBE],
  ] as const) {
    it(`${name}: a second press while pending is stopped before the form can submit again`, async () => {
      clicks.handlers = [];
      await renderSubmitting(state);
      expect(clicks.handlers.length, "the page drew Capsomer's button").toBeGreaterThan(0);
      const click = clicks.handlers[clicks.handlers.length - 1];
      const prevented = vi.fn();
      click({ preventDefault: prevented });
      expect(prevented).toHaveBeenCalledTimes(1);
    });
  }
});
