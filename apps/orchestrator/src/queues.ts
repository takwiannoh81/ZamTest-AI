import { HttpError } from "./jobs.js";
import { newId, nowIso } from "./store.js";
import type { Store } from "./store.js";
import type { Queue, QueueItem, QueueItemStatus } from "./types.js";

export const FINAL_ITEM_STATUSES: QueueItemStatus[] = ["successful", "failed", "business-exception"];

export function findQueue(store: Store, nameOrId: string): Queue {
  const queue =
    store.data.queues[nameOrId] ?? Object.values(store.data.queues).find((q) => q.name.toLowerCase() === nameOrId.toLowerCase());
  if (!queue) throw new HttpError(404, `Queue "${nameOrId}" not found. Create it in the Portal under Queues.`);
  return queue;
}

export function addItem(store: Store, queue: Queue, data: unknown, reference?: string): QueueItem {
  if (reference) {
    const duplicate = Object.values(store.data.queueItems).some((i) => i.queueId === queue.id && i.reference === reference);
    if (duplicate) throw new HttpError(409, `Queue "${queue.name}" already has an item with reference "${reference}"`);
  }
  const item: QueueItem = {
    id: newId("qi"),
    queueId: queue.id,
    reference: reference || undefined,
    data,
    status: "new",
    retries: 0,
    createdAt: nowIso(),
  };
  store.data.queueItems[item.id] = item;
  store.save();
  return item;
}

/** Locks the oldest waiting item for a job (FIFO). */
export function takeNext(store: Store, queue: Queue, jobId: string | undefined, agentId: string): QueueItem | null {
  const item = Object.values(store.data.queueItems)
    .filter((i) => i.queueId === queue.id && i.status === "new")
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
  if (!item) return null;
  item.status = "in-progress";
  item.jobId = jobId;
  item.agentId = agentId;
  item.startedAt = nowIso();
  store.save();
  return item;
}

/**
 * Records the outcome. System failures go back to "new" until the queue's
 * retry limit is reached; business exceptions (bad data) are never retried.
 */
export function completeItem(store: Store, item: QueueItem, status: Exclude<QueueItemStatus, "new" | "in-progress">, result?: unknown, message?: string) {
  const queue = store.data.queues[item.queueId];
  item.result = result;
  item.message = message;
  if (status === "failed" && queue && item.retries < queue.maxRetries) {
    item.retries++;
    item.status = "new";
    item.jobId = undefined;
    item.agentId = undefined;
    item.startedAt = undefined;
  } else {
    item.status = status;
    item.finishedAt = nowIso();
  }
  store.save();
}

/** Items still locked by a job that ended are treated as failed (and retried if allowed). */
export function releaseJobItems(store: Store, jobId: string, reason: string) {
  for (const item of Object.values(store.data.queueItems)) {
    if (item.jobId === jobId && item.status === "in-progress") completeItem(store, item, "failed", undefined, reason);
  }
}

export function queueCounts(store: Store, queueId: string) {
  const counts: Record<QueueItemStatus, number> = { new: 0, "in-progress": 0, successful: 0, failed: 0, "business-exception": 0 };
  for (const item of Object.values(store.data.queueItems)) if (item.queueId === queueId) counts[item.status]++;
  return counts;
}
