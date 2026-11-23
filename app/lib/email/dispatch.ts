import { sha256Hex } from "@dustinedwards/site-runtime/encoding";
import { inList } from "@dustinedwards/site-runtime/d1";
import { and, eq, isNotNull, sql } from "drizzle-orm";

import type { Db } from "~/db";
import { accounts, getDb, emailSends, emailSuppressions } from "~/db";
import { isUniqueConstraintError } from "~/lib/money/serializer";

import { redact } from "@dustinedwards/site-runtime/email";
import { sendJobEmail } from "./send";
import type { OutboundEmailJob } from "./types";

// Email dispatch: suppression gate -> send -> email_sends log. Synchronous inside the recovery cron:
// executeEmailStep -> defaultSend -> processEmailJob -> sendJobEmail -> env.EMAIL.
// defaultSend passes queueMessageId = null; retries come from decideEmailStep's backoff, not a queue.

export type EmailSendStatus =
  | "sent"
  | "suppressed"
  | "failed"
  | "blocked"
  | "pending"
  | "duplicate";

/** email_sends.error for a claim whose outcome is unknown: the row stays `pending`, never `failed`. */
const SEND_CLAIM_MISSING_KEY_ERROR = "email job has no idempotency key";

/** email_sends.error for a send the live-send flag refused; stable so the count is one WHERE clause. */
export const LIVE_SENDS_DISABLED_ERROR = "live sends are disabled for this account";

export interface EmailJobResult {
  status: EmailSendStatus;
  providerMessageId: string | null;
  error: string | null;
  retryable: boolean;
}

export function hashRecipient(email: string): Promise<string> {
  return sha256Hex(email.trim().toLowerCase());
}

export function buildEmailSendRow(
  db: Db,
  input: {
    job: OutboundEmailJob;
    status: EmailSendStatus;
    providerMessageId: string | null;
    error: string | null;
    recipientHash: string;
    queueMessageId: string | null;
    now: Date;
    /** Set only on the claim row. Blocked rows leave it null so switching the merchant on does not find
     *  a claim and skip the send forever. */
    idempotencyKey?: string | null;
  },
) {
  return db.insert(emailSends).values({
    idempotencyKey: input.idempotencyKey ?? null,
    accountId: input.job.accountId,
    recoveryStepId: input.job.recoveryStepId ?? null,
    winBackStepId: input.job.winBackStepId ?? null,
    queueMessageId: input.queueMessageId,
    template: input.job.template,
    recipientHash: input.recipientHash,
    status: input.status,
    providerMessageId: input.providerMessageId,
    error: input.error,
    sentAt: input.status === "sent" ? input.now : null,
    cronRunId: input.job.cronRunId ?? null,
    createdAt: input.now,
  });
}

// Live-send gate: a per-account flag, default OFF, checked here because this is where the send happens.
// Without it every eligible account would mail at once the day PHYSICAL_ADDRESS is set. A blocked send
// is reported as a transient failure (no mail left), so sendResultToAttempt retries it with backoff.

/**
 * Process one email job: suppression gate, then send, then log. A suppressed recipient is a terminal
 * success (no send, no retry); a send failure is retryable.
 */
export async function processEmailJob(
  env: Env,
  job: OutboundEmailJob,
  queueMessageId: string | null,
  gates?: SendGates,
): Promise<EmailJobResult> {
  const db = getDb(env);
  const now = new Date();
  const recipientHash = await hashRecipient(job.to);
  const gate = gates ?? (await SendGates.read(env, [job]));

  if (gate.suppressed(job)) {
    await logSend(db, {
      job,
      status: "suppressed",
      providerMessageId: null,
      error: null,
      recipientHash,
      queueMessageId,
      now,
    });
    return { status: "suppressed", providerMessageId: null, error: null, retryable: false };
  }

  // Live-send gate: after suppression, before the send. Preview mail (own address, no customer) and
  // jobs marked liveSendGate "skip" (platform-to-merchant mail) are not held.
  if (job.audience !== "preview" && job.liveSendGate !== "skip" && !gate.liveSends(job)) {
    await logSend(db, {
      job,
      status: "blocked",
      providerMessageId: null,
      error: LIVE_SENDS_DISABLED_ERROR,
      recipientHash,
      queueMessageId,
      now,
    });
    return {
      status: "blocked",
      providerMessageId: null,
      error: LIVE_SENDS_DISABLED_ERROR,
      retryable: true,
    };
  }

  // The send claim is written BEFORE the provider call, so a worker dying after this line leaves evidence
  // (closing the send-then-claim residual). The unique index is the guard, not a read: two workers racing
  // on one key cannot both proceed. A denied claim is `duplicate`, non-retryable and treated as ok;
  // reporting it as a failure would retry with a fresh key and send the very email the claim prevents.
  const claimed = await claimSend(db, { job, recipientHash, queueMessageId, now });
  if (!claimed) {
    return { status: "duplicate", providerMessageId: null, error: null, retryable: false };
  }

  try {
    const { providerMessageId } = await sendJobEmail(env, job);
    await flipClaimToSent(db, job.idempotencyKey, providerMessageId, now);
    return { status: "sent", providerMessageId, error: null, retryable: false };
  } catch (err) {
    const error = redact(err instanceof Error ? err.message : "send failed", job.redact);
    // The row stays `pending` with the error: `failed` would assert no mail left, which we cannot know
    // (a provider can throw after accepting). The standing claim stops a retry gambling on the answer.
    await recordClaimError(db, job.idempotencyKey, error);
    return { status: "failed", providerMessageId: null, error, retryable: true };
  }
}

/**
 * Take the claim for one logical send. False means the unique index refused it (duplicate), the only
 * error swallowed; any other failure propagates so a broken database fails CLOSED with no mail sent.
 */
async function claimSend(
  db: Db,
  input: {
    job: OutboundEmailJob;
    recipientHash: string;
    queueMessageId: string | null;
    now: Date;
  },
): Promise<boolean> {
  // Fail closed on a missing key: an empty key would collide with every other keyless send.
  if (!input.job.idempotencyKey || !input.job.idempotencyKey.trim()) {
    throw new Error(SEND_CLAIM_MISSING_KEY_ERROR);
  }
  try {
    await buildEmailSendRow(db, {
      job: input.job,
      status: "pending",
      providerMessageId: null,
      error: null,
      recipientHash: input.recipientHash,
      queueMessageId: input.queueMessageId,
      now: input.now,
      idempotencyKey: input.job.idempotencyKey,
    });
    return true;
  } catch (err) {
    if (!isUniqueConstraintError(err)) throw err;
    return retakeRefusedClaim(db, input.job.idempotencyKey, input.now);
  }
}

/**
 * A claim already exists for this key: may this caller take it over? `error IS NULL` means the worker
 * never came back and may have sent the mail, so nobody retries (a second copy to a customer).
 * `error IS NOT NULL` means the provider refused, no mail left, so a retry is safe; stable-key callers
 * (expiring-card, winback-step, recovery-notify) depend on that. The re-take is one conditional UPDATE
 * (`error IS NOT NULL` in its WHERE) so two racing workers cannot both win. Residual: a provider that
 * accepts then fails to answer is recorded as an error and the retry sends a second copy.
 */
async function retakeRefusedClaim(db: Db, idempotencyKey: string, now: Date): Promise<boolean> {
  const retaken = await db
    .update(emailSends)
    .set({ status: "pending", error: null, createdAt: now })
    .where(and(eq(emailSends.idempotencyKey, idempotencyKey), isNotNull(emailSends.error)))
    .returning({ id: emailSends.id });
  return retaken.length === 1;
}

async function flipClaimToSent(
  db: Db,
  idempotencyKey: string,
  providerMessageId: string | null,
  now: Date,
): Promise<void> {
  await db
    .update(emailSends)
    .set({ status: "sent", providerMessageId, sentAt: now })
    .where(eq(emailSends.idempotencyKey, idempotencyKey));
}

async function recordClaimError(db: Db, idempotencyKey: string, error: string): Promise<void> {
  await db.update(emailSends).set({ error }).where(eq(emailSends.idempotencyKey, idempotencyKey));
}

type GatedJob = Pick<OutboundEmailJob, "to" | "accountId">;

/**
 * The two gates processEmailJob passes before the provider is called: the address is not suppressed
 * and the account has live sends on. `read` loads them for a set of jobs in one D1 batch, so a loop of
 * N mails reads once; a suppression written mid-batch is honored from the next batch. Asking about an
 * address or account the read did not cover throws. Live sends fail closed: a missing account or a job
 * with no account reads false. Only processEmailJob is gated; auth mail (sendTransactionalEmail) is
 * not, or merchants would be locked out of their accounts.
 */
export class SendGates {
  readonly #emails: ReadonlySet<string>;
  readonly #accounts: ReadonlySet<string>;
  readonly #suppressed: ReadonlySet<string>;
  readonly #live: ReadonlySet<string>;

  private constructor(
    emails: ReadonlySet<string>,
    accountIds: ReadonlySet<string>,
    suppressed: ReadonlySet<string>,
    live: ReadonlySet<string>,
  ) {
    this.#emails = emails;
    this.#accounts = accountIds;
    this.#suppressed = suppressed;
    this.#live = live;
  }

  /** Both gates for every job in one D1 batch; each list is one bound parameter (inList). */
  static async read(env: Env, jobs: readonly GatedJob[]): Promise<SendGates> {
    const db = getDb(env);
    const emails = new Set(jobs.map((j) => j.to));
    const lowered = [...emails].map((e) => e.toLowerCase());
    const accountIds = new Set(jobs.flatMap((j) => (j.accountId ? [j.accountId] : [])));
    const [suppressed, live] = await db.batch([
      db
        .select({ email: sql<string>`lower(${emailSuppressions.email})` })
        .from(emailSuppressions)
        .where(
          and(
            // Rows are stored lowercase; older mixed-case rows match through lower().
            inList(sql`lower(${emailSuppressions.email})`, lowered),
            isNotNull(emailSuppressions.suppressedAt),
          ),
        ),
      db
        .select({ id: accounts.id })
        .from(accounts)
        .where(and(inList(accounts.id, [...accountIds]), eq(accounts.liveSendsEnabled, true))),
    ]);
    return new SendGates(
      emails,
      accountIds,
      new Set(suppressed.map((r) => r.email)),
      new Set(live.map((r) => r.id)),
    );
  }

  suppressed(job: GatedJob): boolean {
    if (!this.#emails.has(job.to)) throw new Error("SendGates: this address was not read");
    return this.#suppressed.has(job.to.toLowerCase());
  }

  liveSends(job: GatedJob): boolean {
    if (!job.accountId) return false;
    if (!this.#accounts.has(job.accountId)) throw new Error("SendGates: this account was not read");
    return this.#live.has(job.accountId);
  }
}

async function logSend(db: Db, input: Parameters<typeof buildEmailSendRow>[1]): Promise<void> {
  try {
    await buildEmailSendRow(db, input);
  } catch {
    // The send log is best-effort; a logging failure must not re-send the email.
  }
}
