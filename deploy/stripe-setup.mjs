#!/usr/bin/env node
/**
 * Sets up a Stripe account for ZamTech AI's Pro plan, in one go:
 *   - the products "builder seat" and "bot PC", with monthly and yearly prices;
 *   - the customer portal (change seats, cards, invoices, cancel);
 *   - the webhook to https://api.<domain>/api/billing/webhook.
 * Then it prints the lines to paste on the server with
 *   sudo bash ~/ZamTest-AI/deploy/set-env.sh --paste
 *
 * Run it on your own PC (Node 18 or newer), once in test mode and once in live mode:
 *   node deploy/stripe-setup.mjs
 * The secret key is typed hidden and only sent to Stripe. Running it again is safe:
 * it reuses what exists (prices whose amount changed get a new price; old
 * subscribers keep theirs until they change).
 */
import { createInterface } from "node:readline";

// ZAMTECH_STRIPE_API: only for testing this script against a fake Stripe.
const API = process.env.ZAMTECH_STRIPE_API || "https://api.stripe.com/v1";
const EVENTS = [
  "checkout.session.completed",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "customer.subscription.paused",
  "customer.subscription.resumed",
];

/* ------------------------------ prompts ------------------------------ */
const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: Boolean(process.stdin.isTTY) });
let hidden = false;
const write = rl._writeToOutput.bind(rl);
rl._writeToOutput = (text) => (hidden && !/^\r?\n$/.test(text) ? undefined : write(text));
const ask = (question, fallback = "") =>
  new Promise((resolve) => rl.question(fallback ? `${question} [${fallback}]: ` : `${question}: `, (a) => resolve(a.trim() || fallback)));
const askHidden = async (question) => {
  process.stdout.write(`${question}: `);
  hidden = true;
  const answer = await new Promise((resolve) => rl.question("", resolve));
  hidden = false;
  process.stdout.write("\n");
  return answer.trim();
};
const fail = (message) => {
  console.error(`\n${message}`);
  process.exit(1);
};

/* ------------------------------ Stripe API ---------------------------- */
let key = "";
/** Stripe's form encoding: a[b][0]=c. */
function form(data, prefix = "", out = new URLSearchParams()) {
  for (const [k, v] of Object.entries(data)) {
    if (v === undefined || v === null) continue;
    const name = prefix ? `${prefix}[${k}]` : k;
    if (Array.isArray(v)) v.forEach((item, i) => (typeof item === "object" ? form(item, `${name}[${i}]`, out) : out.append(`${name}[${i}]`, String(item))));
    else if (typeof v === "object") form(v, name, out);
    else out.append(name, String(v));
  }
  return out;
}
async function stripe(method, path, data) {
  const url = new URL(API + path);
  if (method === "GET" && data) url.search = form(data).toString();
  const res = await fetch(url, {
    method,
    headers: { authorization: `Bearer ${key}`, "content-type": "application/x-www-form-urlencoded" },
    body: method === "GET" ? undefined : form(data ?? {}).toString(),
  });
  const body = await res.json();
  if (!res.ok) fail(`Stripe said: ${body.error?.message ?? res.status} (${method} ${path})`);
  return body;
}

/* -------------------------------- steps ------------------------------- */
console.log("ZamTech AI - Stripe setup\n");
key = await askHidden("Stripe secret key (sk_test_... or sk_live_..., input hidden)");
if (!/^(sk|rk)_(test|live)_/.test(key)) fail("That does not look like a Stripe secret key (sk_test_... or sk_live_...).");
const live = key.includes("_live_");

const account = await stripe("GET", "/account");
const accountName = account.settings?.dashboard?.display_name || account.business_profile?.name || account.id;
console.log(`\nAccount: ${accountName} (${account.id}), ${live ? "LIVE mode: real payments" : "test mode"}`);
if ((await ask("Is this the ZamTech AI account? (yes/no)", "no")).toLowerCase() !== "yes") fail("Stopped. Use the secret key of the ZamTech AI account.");

const currency = (await ask("Currency", "usd")).toLowerCase();
const dollars = async (question, fallback) => {
  const n = Number(await ask(question, fallback));
  if (!Number.isFinite(n) || n < 0) fail(`Not an amount: ${question}`);
  return Math.round(n * 100);
};
const amounts = {
  builder: { month: await dollars("Builder seat per month", "29"), year: await dollars("Builder seat per year (0 = no yearly price)", "290") },
  bot: { month: await dollars("Bot PC per month", "29"), year: await dollars("Bot PC per year (0 = no yearly price)", "290") },
};
if (!amounts.builder.month || !amounts.bot.month) fail("The monthly prices are required.");
const domain = await ask("Your domain", "zamtechai.com");
const webhookUrl = `https://api.${domain}/api/billing/webhook`;

// Products, found again by their metadata.
const PRODUCTS = {
  builder: { name: "ZamTech AI Pro - builder seat", description: "One person who builds automations (Developer or Admin)" },
  bot: { name: "ZamTech AI Pro - bot PC", description: "One connected bot PC, with 5,000 runs per month" },
};
const existing = (await stripe("GET", "/products", { limit: 100, active: true })).data;
const products = {};
for (const kind of ["builder", "bot"]) {
  const found = existing.find((p) => p.metadata?.zamtech_kind === kind);
  products[kind] = found ?? (await stripe("POST", "/products", { ...PRODUCTS[kind], metadata: { zamtech_kind: kind } }));
  console.log(`${found ? "Found" : "Created"} product: ${products[kind].name}`);
}

// Prices, found again by lookup key; a changed amount gets a new price (the lookup key moves to it).
const prices = {};
for (const kind of ["builder", "bot"]) {
  for (const interval of ["month", "year"]) {
    const amount = amounts[kind][interval];
    if (!amount) continue;
    const lookup = `zamtech_${kind}_${interval}ly`;
    const current = (await stripe("GET", "/prices", { "lookup_keys[]": lookup, active: true })).data[0];
    if (current && current.unit_amount === amount && current.currency === currency && current.product === products[kind].id) {
      prices[`${kind}_${interval}`] = current.id;
      console.log(`Found price: ${lookup} ${amount / 100} ${currency}`);
      continue;
    }
    const price = await stripe("POST", "/prices", {
      product: products[kind].id,
      currency,
      unit_amount: amount,
      recurring: { interval, usage_type: "licensed" },
      lookup_key: lookup,
      transfer_lookup_key: true,
      nickname: `${PRODUCTS[kind].name}, per ${interval}`,
    });
    prices[`${kind}_${interval}`] = price.id;
    console.log(`Created price: ${lookup} ${amount / 100} ${currency}`);
  }
}

// Customer portal: change the number of seats and bot PCs, cards, invoices, cancel at the period's end.
const portalProducts = ["builder", "bot"].map((kind) => ({
  product: products[kind].id,
  prices: ["month", "year"].map((i) => prices[`${kind}_${i}`]).filter(Boolean),
}));
const portalSettings = {
  business_profile: { headline: "ZamTech AI - manage your Pro subscription" },
  features: {
    customer_update: { enabled: true, allowed_updates: ["email", "name", "address", "tax_id"] },
    invoice_history: { enabled: true },
    payment_method_update: { enabled: true },
    subscription_cancel: { enabled: true, mode: "at_period_end" },
    subscription_update: { enabled: true, default_allowed_updates: ["quantity"], proration_behavior: "create_prorations", products: portalProducts },
  },
  default_return_url: `https://portal.${domain}/#/billing`,
  metadata: { zamtech: "pro" },
};
const configs = (await stripe("GET", "/billing_portal/configurations", { limit: 100, active: true })).data;
const oldConfig = configs.find((c) => c.metadata?.zamtech === "pro");
const portal = oldConfig
  ? await stripe("POST", `/billing_portal/configurations/${oldConfig.id}`, portalSettings)
  : await stripe("POST", "/billing_portal/configurations", portalSettings);
console.log(`${oldConfig ? "Updated" : "Created"} customer portal settings: ${portal.id}`);

// Webhook: Stripe shows its signing secret only when it is created, so an old one is replaced.
const hooks = (await stripe("GET", "/webhook_endpoints", { limit: 100 })).data.filter((h) => h.url === webhookUrl);
if (hooks.length) {
  const replace = (await ask(`A webhook to ${webhookUrl} exists; replace it with a new one (its secret changes)? (yes/no)`, "yes")).toLowerCase();
  if (replace !== "yes") fail("Stopped. Keep the old webhook's secret on the server, or run again and replace it.");
  for (const h of hooks) await stripe("DELETE", `/webhook_endpoints/${h.id}`);
}
const hook = await stripe("POST", "/webhook_endpoints", { url: webhookUrl, enabled_events: EVENTS, description: "ZamTech AI orchestrator: plans and seats" });
console.log(`Created webhook: ${webhookUrl}`);
rl.close();

const lines = [
  `STRIPE_SECRET_KEY=${key}`,
  `STRIPE_WEBHOOK_SECRET=${hook.secret}`,
  `STRIPE_PRICE_BUILDER_MONTHLY=${prices.builder_month}`,
  `STRIPE_PRICE_BOT_MONTHLY=${prices.bot_month}`,
  ...(prices.builder_year ? [`STRIPE_PRICE_BUILDER_YEARLY=${prices.builder_year}`] : []),
  ...(prices.bot_year ? [`STRIPE_PRICE_BOT_YEARLY=${prices.bot_year}`] : []),
  `STRIPE_PORTAL_CONFIGURATION=${portal.id}`,
];
console.log(`
Done. Now, on the server (Lightsail > Connect using SSH), run:

  sudo bash ~/ZamTest-AI/deploy/set-env.sh --paste

and paste these lines (they contain your secret key: do not share them), then press Enter on an empty line:
------------------------------------------------------------------------
${lines.join("\n")}
------------------------------------------------------------------------
The orchestrator's log then says "Billing: Stripe (${live ? "live" : "test"} mode)".`);
