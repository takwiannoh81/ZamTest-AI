import type { ActionContext, ActionHandler } from "@zamtest/core";

export type QueueItemStatus = "successful" | "failed" | "business-exception";

export interface QueueItem {
  id: string;
  queue: string;
  reference?: string;
  data: unknown;
  retries: number;
}

/** Provided by the bot agent when it runs a job for the orchestrator. */
export interface QueueService {
  add(queue: string, data: unknown, reference?: string): Promise<{ id: string }>;
  next(queue: string): Promise<QueueItem | null>;
  complete(id: string, status: QueueItemStatus, result?: unknown, message?: string): Promise<void>;
}

function queues(ctx: ActionContext): QueueService {
  const service = ctx.services.queues as QueueService | undefined;
  if (!service) throw new Error("Work queues are only available when running under the orchestrator");
  return service;
}

export const queueHandlers: Record<string, ActionHandler> = {
  "queue.add": async (props, ctx) => {
    const item = await queues(ctx).add(String(props.queue), props.data, props.reference ? String(props.reference) : undefined);
    return item.id;
  },

  "queue.getNext": async (props, ctx) => {
    const item = await queues(ctx).next(String(props.queue));
    ctx.log("info", item ? `Processing queue item ${item.reference ?? item.id}` : `Queue "${props.queue}" is empty`);
    return item;
  },

  "queue.complete": async (props, ctx) => {
    const item = props.item as { id?: string } | string | null | undefined;
    const id = typeof item === "string" ? item : item?.id;
    if (!id) throw new Error("Item is empty; use the value saved by Get Next Queue Item");
    await queues(ctx).complete(
      id,
      (String(props.status || "successful") as QueueItemStatus),
      props.result,
      props.message ? String(props.message) : undefined,
    );
  },
};
