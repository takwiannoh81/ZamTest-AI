import Stripe from "stripe";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { buildApp } from "../src/app.js";
import { StripeBilling } from "../src/billing.js";
import type { BillingConfig, BillingProvider } from "../src/billing.js";
import { loadConfig } from "../src/config.js";
import { Store } from "../src/store.js";

let app: FastifyInstance;
let store: Store;
afterEach(() => app?.close());

const TOKEN = "master-token-0123456789abcdef";
const master = { authorization: `Bearer ${TOKEN}` };
const PASSWORD = "correct horse battery";
const WEBHOOK_SECRET = "whsec_test_secret";
const stripeConfig: BillingConfig = {
  secretKey: "sk_test_not_used",
  webhookSecret: WEBHOOK_SECRET,
  prices: { builder: { month: "price_builder_m", year: "price_builder_y" }, bot: { month: "price_bot_m", year: "price_bot_y" } },
  automaticTax: false,
};

/** Records what the Portal asked the payment provider; webhooks go through the real Stripe code. */
class FakeBilling implements BillingProvider {
  calls: Array<{ op: string; input: unknown }> = [];
  private readonly real = new StripeBilling(stripeConfig);
  async prices() {
    return { currency: "usd", builder: { month: 3000, year: 30000 }, bot: { month: 5000, year: 50000 } };
  }
  async createCustomer(input: unknown) {
    this.calls.push({ op: "customer", input });
    return "cus_123";
  }
  async checkout(input: unknown) {
    this.calls.push({ op: "checkout", input });
    return "https://checkout.stripe.test/session";
  }
  async portal(input: unknown) {
    this.calls.push({ op: "portal", input });
    return "https://billing.stripe.test/portal";
  }
  parseWebhook(raw: Buffer, signature: string) {
    return this.real.parseWebhook(raw, signature);
  }
}

async function setup(billing: BillingProvider | null = new FakeBilling()) {
  store = new Store(null);
  const config = { ...loadConfig({ ZAMTEST_ADMIN_TOKEN: TOKEN, ZAMTEST_ALLOW_SIGNUP: "true", ZAMTEST_PORTAL_URL: "https://portal.zamtechai.com" }), dataDir: null };
  ({ app } = await buildApp({ config, store, ai: null, billing }));
  return billing as FakeBilling;
}

const cookieOf = (res: LightMyRequestResponse) => String(res.headers["set-cookie"]).split(";")[0]!;
async function signUp(company = "Acme") {
  const res = await app.inject({
    method: "POST",
    url: "/api/auth/signup",
    payload: { company, name: "Owner", email: `owner@${company.toLowerCase()}.example`, password: PASSWORD },
  });
  const headers = { cookie: cookieOf(res), "x-zamtech-client": "test" };
  const workspaceId: string = (await app.inject({ method: "GET", url: "/api/workspace", headers })).json().id;
  return { headers, workspaceId };
}
const call = (headers: Record<string, string>, method: "GET" | "POST", url: string, payload?: unknown) =>
  app.inject({ method, url, headers, payload: payload as object });

/** A Stripe subscription as the API sends it in webhooks (only the fields the orchestrator reads). */
function subscription(workspaceId: string | undefined, status: string, builders: number, bots: number, id = "sub_1") {
  const item = (price: string, quantity: number) => ({
    id: `si_${price}`,
    object: "subscription_item",
    quantity,
    current_period_end: 1_800_000_000,
    price: { id: price, object: "price", recurring: { interval: "month" } },
  });
  return {
    id,
    object: "subscription",
    customer: "cus_123",
    status,
    cancel_at_period_end: false,
    metadata: workspaceId ? { workspaceId } : {},
    items: { object: "list", data: [item("price_builder_m", builders), item("price_bot_m", bots)] },
  };
}

/** Sends a webhook signed like Stripe signs it. */
async function webhook(type: string, object: unknown, secret = WEBHOOK_SECRET) {
  const payload = JSON.stringify({ id: `evt_${Math.random()}`, object: "event", type, created: 1_790_000_000, api_version: "2026-08-26.dahlia", data: { object } });
  const signature = new Stripe("sk_test_not_used").webhooks.generateTestHeaderString({ payload, secret });
  return app.inject({ method: "POST", url: "/api/billing/webhook", headers: { "content-type": "application/json", "stripe-signature": signature }, payload });
}

describe("buying the Pro plan", () => {
  it("opens Stripe Checkout for the seats an admin chooses", async () => {
    const billing = await setup();
    const { headers, workspaceId } = await signUp();
    const plans = (await call(headers, "GET", "/api/billing/plans")).json();
    expect(plans).toMatchObject({ configured: true, prices: { builder: { month: 3000 }, bot: { month: 5000 } } });

    const res = await call(headers, "POST", "/api/billing/checkout", { interval: "year", builders: 3, bots: 2 });
    expect(res.json()).toEqual({ url: "https://checkout.stripe.test/session" });
    expect(billing.calls).toEqual([
      { op: "customer", input: { workspaceId, name: "Acme", email: "owner@acme.example" } },
      {
        op: "checkout",
        input: {
          customerId: "cus_123",
          workspaceId,
          interval: "year",
          builders: 3,
          bots: 2,
          successUrl: "https://portal.zamtechai.com/#/billing?checkout=done",
          cancelUrl: "https://portal.zamtechai.com/#/billing",
        },
      },
    ]);
    // The Stripe customer is created once and reused.
    await call(headers, "POST", "/api/billing/checkout", { builders: 1, bots: 1 });
    expect(billing.calls.filter((c) => c.op === "customer")).toHaveLength(1);
    expect((await call(headers, "POST", "/api/billing/portal")).json()).toEqual({ url: "https://billing.stripe.test/portal" });
  });

  it("is for admins, needs Stripe to be set up, and cannot buy fewer seats than are in use", async () => {
    await setup();
    const { headers } = await signUp();
    await call(headers, "POST", "/api/users", { email: "op@acme.example", name: "Op", role: "operator", password: PASSWORD });
    const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "op@acme.example", password: PASSWORD } });
    const operator = { cookie: cookieOf(login), "x-zamtech-client": "test" };
    expect((await call(operator, "POST", "/api/billing/checkout", { builders: 1, bots: 1 })).statusCode).toBe(403);
    expect((await call(headers, "POST", "/api/billing/portal")).statusCode).toBe(409);
    await app.close();

    await setup(null);
    const other = await signUp("Globex");
    expect((await call(other.headers, "GET", "/api/billing/plans")).json()).toMatchObject({ configured: false });
    expect((await call(other.headers, "POST", "/api/billing/checkout", { builders: 1, bots: 1 })).statusCode).toBe(503);
    expect((await call(other.headers, "GET", "/api/workspace")).json().billingAvailable).toBe(false);
  });
});

describe("Stripe webhooks", () => {
  it("move a workspace to Pro with the seats paid for, and back to Free when the subscription ends", async () => {
    await setup();
    const { headers, workspaceId } = await signUp();
    expect((await webhook("customer.subscription.created", subscription(workspaceId, "active", 3, 2))).json()).toEqual({ received: true });
    let summary = (await call(headers, "GET", "/api/workspace")).json();
    expect(summary).toMatchObject({
      plan: "pro",
      seats: { builders: 3, bots: 2 },
      limits: { builders: 3, bots: 2, schedules: true },
      billing: { status: "active", interval: "month", cancelAtPeriodEnd: false },
    });
    expect(summary.billing.currentPeriodEnd).toBe(new Date(1_800_000_000 * 1000).toISOString());

    // Seats changed in Stripe's portal; the card failing keeps Pro while Stripe retries.
    await webhook("customer.subscription.updated", subscription(workspaceId, "past_due", 5, 4));
    expect((await call(headers, "GET", "/api/workspace")).json()).toMatchObject({ plan: "pro", seats: { builders: 5, bots: 4 }, billing: { status: "past_due" } });

    // Found by Stripe customer even without the workspace id in the subscription.
    await webhook("customer.subscription.deleted", subscription(undefined, "canceled", 5, 4));
    summary = (await call(headers, "GET", "/api/workspace")).json();
    expect(summary).toMatchObject({ plan: "free", billing: { status: "canceled" } });
    expect(summary.seats).toBeUndefined();
  });

  it("reject unsigned or wrongly signed calls, and leave Enterprise agreements alone", async () => {
    await setup();
    const { headers, workspaceId } = await signUp();
    const forged = await webhook("customer.subscription.created", subscription(workspaceId, "active", 99, 99), "whsec_wrong");
    expect(forged.statusCode).toBe(400);
    const unsigned = await app.inject({ method: "POST", url: "/api/billing/webhook", headers: { "content-type": "application/json" }, payload: "{}" });
    expect(unsigned.statusCode).toBe(400);
    expect((await call(headers, "GET", "/api/workspace")).json().plan).toBe("free");

    await app.inject({ method: "PUT", url: `/api/platform/workspaces/${workspaceId}`, headers: master, payload: { plan: "enterprise" } });
    await webhook("customer.subscription.deleted", subscription(workspaceId, "canceled", 1, 1));
    expect((await call(headers, "GET", "/api/workspace")).json()).toMatchObject({ plan: "enterprise", billing: { status: "canceled" } });
  });

  it("do not let an old subscription's end cancel the current one", async () => {
    await setup();
    const { headers, workspaceId } = await signUp();
    await webhook("customer.subscription.created", subscription(workspaceId, "active", 2, 2, "sub_new"));
    await webhook("customer.subscription.deleted", subscription(workspaceId, "canceled", 1, 1, "sub_old"));
    expect((await call(headers, "GET", "/api/workspace")).json()).toMatchObject({ plan: "pro", seats: { builders: 2, bots: 2 } });
    // Other event types are acknowledged and ignored.
    expect((await webhook("invoice.created", { id: "in_1", object: "invoice" })).json()).toEqual({ received: true });
  });
});
