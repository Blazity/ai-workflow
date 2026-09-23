/**
 * Who holds the run slots the Overview counts.
 *
 * The worker counts a slot for every claim dispatch refuses against
 * (`listCapacityConsumers`): an executing run, a run parked on a question,
 * which keeps its slot until it is answered or cancelled, and claims between
 * those states (a dispatch starting a run, a finished run whose claim is being
 * released). It sends only the total. The dashboard knows the first two from
 * the live board, so the rest is what neither explains.
 *
 * "0 executing, 4/20 slots, No runs in flight" was all the Overview said while
 * three parked runs and a claim being released held four slots (QA), which
 * reads as a leak. An awaiting row need not hold a slot (a plan parked on the
 * Approvals page ended its run), so the parked count is capped at the slots
 * the executing runs leave, and the sentence never claims more holders than
 * slots are taken.
 */

export interface SlotHolders {
  executing: number;
  parked: number;
  /** Slots neither an executing nor a parked run on the board explains. */
  startingOrFinishing: number;
}

export function slotHolders(input: {
  occupiedSlots: number;
  executing: number;
  awaiting: number;
}): SlotHolders {
  const left = Math.max(0, input.occupiedSlots - input.executing);
  const parked = Math.min(input.awaiting, left);
  return {
    executing: input.executing,
    parked,
    startingOrFinishing: left - parked,
  };
}

function slots(count: number): string {
  return count === 1 ? "slot" : "slots";
}

/** What holds the slots no executing run does, or null when nothing else does. */
export function slotHoldersSentence(holders: SlotHolders): string | null {
  const { parked, startingOrFinishing: other } = holders;
  const parkedPart =
    parked > 0
      ? `${parked} ${slots(parked)} held by ${parked === 1 ? "a parked run" : "parked runs"} until answered or cancelled`
      : null;
  const otherBy = other === 1 ? "a run starting or finishing" : "runs starting or finishing";
  if (parkedPart && other > 0) return `${parkedPart}, ${other} by ${otherBy}.`;
  if (parkedPart) return `${parkedPart}.`;
  if (other > 0) return `${other} ${slots(other)} held by ${otherBy}.`;
  return null;
}
