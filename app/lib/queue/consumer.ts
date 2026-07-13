import { EMAIL_EVENTS_QUEUE_NAME, EMAIL_QUEUE_NAME } from "~/lib/constants";
import { processEmailJob } from "~/lib/email/dispatch";
import { processEmailEvent, type EmailServiceEvent } from "~/lib/email/events";
import type { EmailJob } from "~/lib/email/types";

// Single queue-consumer entry, dispatched by queue name:
//   foxhound-email        -> send each job through the one send module (ack/retry)
//   foxhound-email-events -> bounce/complaint events into the suppression list
// Each queue's own retry ceiling + dead-letter (wrangler consumer config) handles
// repeated failures. Wired into the worker entry's `queue` handler.
export async function handleQueueBatch(batch: MessageBatch<unknown>, env: Env): Promise<void> {
  if (batch.queue === EMAIL_QUEUE_NAME) {
    for (const message of batch.messages) {
      const result = await processEmailJob(env, message.body as EmailJob, message.id);
      if (result.retryable) {
        message.retry();
      } else {
        message.ack();
      }
    }
    return;
  }

  if (batch.queue === EMAIL_EVENTS_QUEUE_NAME) {
    for (const message of batch.messages) {
      try {
        await processEmailEvent(env, message.body as EmailServiceEvent);
        message.ack();
      } catch {
        message.retry();
      }
    }
    return;
  }

  // Unknown queue: ack so nothing wedges. Specific consumers are added by name.
  for (const message of batch.messages) {
    message.ack();
  }
}
