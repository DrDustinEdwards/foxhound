// J43 review: the audit history's Settings card saves on every change, as
// Recova's AuditSettingsForm does. Its controls stay enabled during a save
// (disabling the radio that has focus throws focus to the page body), so a
// change can arrive while a save is still in flight. Sending a second POST at
// once would let two saves land in either order; this holds every change made
// mid-save and sends one more save after the first settles. The form posts
// what the controls show at that moment, so the last value wins.

export interface SaveQueue {
  /** A control changed. Saves now, or marks one more save as owed. */
  change(): void;
  /** The save in flight finished. Sends the owed save, if any. */
  settled(): void;
}

export function createSaveQueue(submit: () => void): SaveQueue {
  let inFlight = false;
  let owed = false;
  return {
    change() {
      if (inFlight) {
        owed = true;
        return;
      }
      inFlight = true;
      submit();
    },
    settled() {
      inFlight = false;
      if (!owed) return;
      owed = false;
      inFlight = true;
      submit();
    },
  };
}
