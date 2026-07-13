import { EMAIL_QUEUE_NAME } from "~/lib/constants";
import { processEmailJob } from "~/lib/email/dispatch";
import type { EmailJob } from "~/lib/email/types";

// Single queue-consumer entry, dispatched by queue name. The email dispatch queue
// sends each job through the one send module and acks vs retries on the result;
// the queue's own retry ceiling + dead-letter (wrangler consumer config) handle
// repeated failures. The email-events (bounce/complaint) queue branch lands in
// 4c-C3. Wired into the worker entry's `queue` handler.
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

  // Unknown queue: ack so nothing wedges. Specific consumers are added by name.
  for (const message of batch.messages) {
    message.ack();
  }
}
