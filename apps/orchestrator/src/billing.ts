/**
 * Paying for the Pro plan with Stripe: Checkout for new subscriptions, the
 * customer portal for changes, cards and invoices, and webhooks that keep each
 * workspace's plan and seats in step with its subscription.
 *
 * Configure (test mode first) with:
 *   STRIPE_SECRET_KEY               sk_test_... / sk_live_...
 *   STRIPE_WEBHOOK_SECRET           whsec_... of the endpoint https://api.<domain>/api/billing/webhook
 *   STRIPE_PRICE_BUILDER_MONTHLY    price_... per builder seat per month
 *   STRIPE_PRICE_BOT_MONTHLY        price_... per bot per month
 *   STRIPE_PRICE_BUILDER_YEARLY     optional, per builder seat per year
 *   STRIPE_PRICE_BOT_YEARLY         optional, per bot per year
 *   STRIPE_AUTOMATIC_TAX=true       optional, when Stripe Tax is set up
 *   STRIPE_PORTAL_CONFIGURATION     optional, customer portal settings (bpc_...) made by deploy/stripe-setup.mjs
 */
import Stripe from "stripe";

export type Interval = "month" | "year";

export interface BillingConfig {
  secretKey: string;
  webhookSecret: string;
  prices: { builder: Record<Interval, string | undefined>; bot: Record<Interval, string | undefined> };
  automaticTax: boolean;
  /** Customer portal settings to use (bpc_...); unset = the account's default ones. */
  portalConfiguration?: string;
}

export function loadBillingConfig(env = process.env): BillingConfig | null {
  const { STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, STRIPE_PRICE_BUILDER_MONTHLY, STRIPE_PRICE_BOT_MONTHLY } = env;
  if (!STRIPE_SECRET_KEY || !STRIPE_WEBHOOK_SECRET || !STRIPE_PRICE_BUILDER_MONTHLY || !STRIPE_PRICE_BOT_MONTHLY) return null;
  return {
    secretKey: STRIPE_SECRET_KEY,
    webhookSecret: STRIPE_WEBHOOK_SECRET,
    prices: {
      builder: { month: STRIPE_PRICE_BUILDER_MONTHLY, year: env.STRIPE_PRICE_BUILDER_YEARLY || undefined },
      bot: { month: STRIPE_PRICE_BOT_MONTHLY, year: env.STRIPE_PRICE_BOT_YEARLY || undefined },
    },
    automaticTax: env.STRIPE_AUTOMATIC_TAX === "true",
    portalConfiguration: env.STRIPE_PORTAL_CONFIGURATION || undefined,
  };
}

/** Prices in the currency's smallest unit (cents), as set in Stripe. */
export interface PriceList {
  currency: string;
  builder: Partial<Record<Interval, number>>;
  bot: Partial<Record<Interval, number>>;
}

/** A subscription as the orchestrator needs it. */
export interface SubscriptionState {
  workspaceId?: string;
  customerId: string;
  subscriptionId: string;
  /** Stripe status: active, trialing, past_due, canceled, unpaid, incomplete, incomplete_expired, paused. */
  status: string;
  interval?: Interval;
  builders: number;
  bots: number;
  currentPeriodEnd?: string;
  cancelAtPeriodEnd: boolean;
}

/** What the orchestrator needs from the payment provider: Stripe in production, a fake in tests. */
export interface BillingProvider {
  prices(): Promise<PriceList>;
  createCustomer(input: { workspaceId: string; name: string; email?: string }): Promise<string>;
  /** Returns the URL of Stripe's hosted payment page. */
  checkout(input: {
    customerId: string;
    workspaceId: string;
    interval: Interval;
    builders: number;
    bots: number;
    successUrl: string;
    cancelUrl: string;
  }): Promise<string>;
  /** Returns the URL of Stripe's customer portal (plan changes, cards, invoices). */
  portal(input: { customerId: string; returnUrl: string }): Promise<string>;
  /** Checks the webhook's signature; returns the subscription it is about, or null for other events. */
  parseWebhook(rawBody: Buffer, signature: string): Promise<SubscriptionState | null>;
}

/** Subscription statuses in which the customer keeps the Pro plan (past_due: Stripe is still retrying the card). */
export const PAID_STATUSES = ["active", "trialing", "past_due"];

export class StripeBilling implements BillingProvider {
  private stripe: Stripe;
  private cachedPrices?: { at: number; list: PriceList };

  constructor(private readonly config: BillingConfig) {
    this.stripe = new Stripe(config.secretKey);
  }

  async prices(): Promise<PriceList> {
    if (this.cachedPrices && Date.now() - this.cachedPrices.at < 10 * 60_000) return this.cachedPrices.list;
    const list: PriceList = { currency: "usd", builder: {}, bot: {} };
    for (const kind of ["builder", "bot"] as const) {
      for (const interval of ["month", "year"] as const) {
        const id = this.config.prices[kind][interval];
        if (!id) continue;
        const price = await this.stripe.prices.retrieve(id);
        list.currency = price.currency;
        if (price.unit_amount !== null) list[kind][interval] = price.unit_amount;
      }
    }
    this.cachedPrices = { at: Date.now(), list };
    return list;
  }

  async createCustomer(input: { workspaceId: string; name: string; email?: string }): Promise<string> {
    const customer = await this.stripe.customers.create({ name: input.name, email: input.email, metadata: { workspaceId: input.workspaceId } });
    return customer.id;
  }

  async checkout(input: Parameters<BillingProvider["checkout"]>[0]): Promise<string> {
    const builderPrice = this.config.prices.builder[input.interval];
    const botPrice = this.config.prices.bot[input.interval];
    if (!builderPrice || !botPrice) throw new Error(`No ${input.interval}ly prices are configured`);
    const session = await this.stripe.checkout.sessions.create({
      mode: "subscription",
      customer: input.customerId,
      client_reference_id: input.workspaceId,
      line_items: [
        { price: builderPrice, quantity: input.builders },
        { price: botPrice, quantity: input.bots },
      ],
      subscription_data: { metadata: { workspaceId: input.workspaceId } },
      allow_promotion_codes: true,
      automatic_tax: { enabled: this.config.automaticTax },
      ...(this.config.automaticTax ? { customer_update: { address: "auto" as const, name: "auto" as const } } : {}),
      success_url: input.successUrl,
      cancel_url: input.cancelUrl,
    });
    if (!session.url) throw new Error("Stripe did not return a checkout page");
    return session.url;
  }

  async portal(input: { customerId: string; returnUrl: string }): Promise<string> {
    const session = await this.stripe.billingPortal.sessions.create({
      customer: input.customerId,
      return_url: input.returnUrl,
      ...(this.config.portalConfiguration ? { configuration: this.config.portalConfiguration } : {}),
    });
    return session.url;
  }

  async parseWebhook(rawBody: Buffer, signature: string): Promise<SubscriptionState | null> {
    const event = this.stripe.webhooks.constructEvent(rawBody, signature, this.config.webhookSecret);
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object;
        const id = typeof session.subscription === "string" ? session.subscription : session.subscription?.id;
        return id ? this.state(await this.stripe.subscriptions.retrieve(id)) : null;
      }
      case "customer.subscription.created":
      case "customer.subscription.updated":
      case "customer.subscription.deleted":
      case "customer.subscription.paused":
      case "customer.subscription.resumed":
        return this.state(event.data.object);
      default:
        return null;
    }
  }

  private state(subscription: Stripe.Subscription): SubscriptionState {
    let builders = 0;
    let bots = 0;
    let interval: Interval | undefined;
    let periodEnd = 0;
    const builderPrices = Object.values(this.config.prices.builder);
    const botPrices = Object.values(this.config.prices.bot);
    for (const item of subscription.items.data) {
      if (builderPrices.includes(item.price.id)) builders += item.quantity ?? 0;
      if (botPrices.includes(item.price.id)) bots += item.quantity ?? 0;
      const recurring = item.price.recurring?.interval;
      if (recurring === "month") interval = "month";
      else if (recurring === "year") interval = "year";
      // The billing period is kept per item in current Stripe API versions.
      periodEnd = Math.max(periodEnd, item.current_period_end ?? 0);
    }
    return {
      workspaceId: subscription.metadata?.workspaceId,
      customerId: typeof subscription.customer === "string" ? subscription.customer : subscription.customer.id,
      subscriptionId: subscription.id,
      status: subscription.status,
      interval,
      builders,
      bots,
      currentPeriodEnd: periodEnd ? new Date(periodEnd * 1000).toISOString() : undefined,
      cancelAtPeriodEnd: subscription.cancel_at_period_end,
    };
  }
}
