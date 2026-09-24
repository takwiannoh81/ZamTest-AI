import { useI18n } from "@zamtest/i18n/react";
import type { MessageKey } from "@zamtest/i18n";
import { useEffect, useState } from "react";
import { api } from "../api";
import type { BillingPlans, WorkspaceSummary } from "../api";
import { usePoll } from "../hooks";
import { SALES_EMAIL } from "../links";
import { atLeast, useMe } from "../session";
import { ErrorBanner, PageHeader } from "../ui";

/** Limits this large mean "no limit" (see plans.ts). */
const isUnlimited = (n: number) => n >= 1e12;
const PAID = ["active", "trialing", "past_due"];

/**
 * The workspace's plan and this month's usage; admins upgrade to Pro through
 * Stripe Checkout and manage an existing subscription in Stripe's portal.
 */
export function Billing({ query }: { query: string }) {
  const { t, locale, dateTime } = useI18n();
  const me = useMe();
  const justPaid = new URLSearchParams(query).get("checkout") === "done";
  // After Stripe Checkout the plan changes when Stripe's webhook arrives: keep looking until then.
  const { data: ws, error } = usePoll<WorkspaceSummary>("/api/workspace", justPaid ? 3000 : 15000);
  const { data: plans } = usePoll<BillingPlans>("/api/billing/plans", 0);
  const [interval, setBillingInterval] = useState<"month" | "year">("month");
  const [builders, setBuilders] = useState(1);
  const [bots, setBots] = useState(1);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string>();
  const isAdmin = atLeast(me, "admin");

  // Start the seat pickers at what the workspace already uses.
  useEffect(() => {
    if (!ws) return;
    setBuilders((n) => Math.max(n, ws.usage.builders, 1));
    setBots((n) => Math.max(n, ws.usage.bots, 1));
  }, [ws?.usage.builders, ws?.usage.bots]); // eslint-disable-line react-hooks/exhaustive-deps

  const money = (cents: number) =>
    new Intl.NumberFormat(locale, { style: "currency", currency: (plans?.prices?.currency ?? "usd").toUpperCase() }).format(cents / 100);

  const go = async (path: string, body?: unknown) => {
    setBusy(true);
    setFailure(undefined);
    try {
      const { url } = await api<{ url: string }>(path, { method: "POST", body });
      window.location.assign(url);
    } catch (e) {
      setFailure((e as Error).message);
      setBusy(false);
    }
  };

  if (!ws) return <ErrorBanner error={error} />;

  const subscribed = PAID.includes(ws.billing?.status ?? "");
  const hasYearly = plans?.prices?.builder.year !== undefined && plans?.prices?.bot.year !== undefined;
  const builderPrice = plans?.prices?.builder[interval];
  const botPrice = plans?.prices?.bot[interval];
  const total = builderPrice !== undefined && botPrice !== undefined ? builderPrice * builders + botPrice * bots : undefined;
  const pro = plans?.included.pro;

  const meter = (label: string, used: number, limit: number, hint?: string) => (
    <div className="meter" key={label}>
      <div className="meter-head">
        <span>{label}</span>
        <strong>
          {used} / {isUnlimited(limit) ? t("billing.unlimited") : limit}
        </strong>
      </div>
      {!isUnlimited(limit) && (
        <div className="meter-bar">
          <div className={used >= limit ? "meter-fill full" : "meter-fill"} style={{ width: `${Math.min(100, (used / Math.max(limit, 1)) * 100)}%` }} />
        </div>
      )}
      {hint && <small className="muted">{hint}</small>}
    </div>
  );

  return (
    <>
      <PageHeader title={t("nav.billing")} subtitle={t("billing.subtitle")} />
      <ErrorBanner error={error ?? failure} />
      {justPaid && ws.plan === "free" && <p className="notice">{t("billing.thanks")}</p>}
      {ws.billing?.status === "past_due" && <div className="error-banner">{t("billing.pastDue")}</div>}

      <div className="card billing-card">
        <div className="billing-plan">
          <span className="muted">{t("billing.currentPlan")}</span>
          <h2>
            <span className={`plan-badge plan-${ws.plan}`}>{t(`plan.${ws.plan}` as MessageKey)}</span>
          </h2>
          {subscribed && ws.billing?.currentPeriodEnd && (
            <span className="muted">
              {t(ws.billing.cancelAtPeriodEnd ? "billing.ends" : "billing.renews", { date: dateTime(ws.billing.currentPeriodEnd) })}
            </span>
          )}
        </div>
        <div className="meters">
          {meter(t("billing.builders"), ws.usage.builders, ws.limits.builders, t("billing.buildersHint"))}
          {meter(t("billing.bots"), ws.usage.bots, ws.limits.bots)}
          {meter(t("billing.runs"), ws.usage.runs, ws.limits.runsPerMonth)}
          {meter(t("billing.ai"), ws.usage.ai, ws.limits.aiPerMonth)}
        </div>
        <div className="features">
          <span>
            {t("billing.schedules")}: <strong>{ws.limits.schedules ? t("billing.included") : t("billing.notIncluded")}</strong>
          </span>
          <span>
            {t("billing.installKeys")}: <strong>{ws.limits.installKeys ? t("billing.included") : t("billing.notIncluded")}</strong>
          </span>
        </div>
        {isAdmin && ws.billingAvailable && (subscribed || ws.billing?.status) && (
          <div className="billing-manage">
            <button className="btn-ghost" disabled={busy} onClick={() => void go("/api/billing/portal")}>
              {t("billing.manage")}
            </button>
            <small className="muted">{t("billing.manageHelp")}</small>
          </div>
        )}
      </div>

      {ws.plan === "free" && (
        <div className="card billing-card">
          <h2>{t("billing.upgradeTitle")}</h2>
          {pro && <p className="muted">{t("billing.proIncludes", { runs: pro.runsPerBot.toLocaleString(locale), ai: pro.aiPerBuilder.toLocaleString(locale) })}</p>}
          {!ws.billingAvailable || !plans?.configured ? (
            <p className="notice">{t("billing.notConfigured")}</p>
          ) : (
            <>
              {hasYearly && (
                <div className="segmented" role="group">
                  <button className={interval === "month" ? "active" : ""} onClick={() => setBillingInterval("month")}>
                    {t("billing.monthly")}
                  </button>
                  <button className={interval === "year" ? "active" : ""} onClick={() => setBillingInterval("year")}>
                    {t("billing.yearly")}
                  </button>
                </div>
              )}
              <div className="seat-grid">
                <label className="field">
                  <span>{t("billing.builders")}</span>
                  <input type="number" min={Math.max(1, ws.usage.builders)} max={1000} value={builders} onChange={(e) => setBuilders(Math.max(1, Number(e.target.value)))} />
                  {builderPrice !== undefined && <small className="muted">{t("billing.pricePerBuilder", { price: money(builderPrice) })}</small>}
                </label>
                <label className="field">
                  <span>{t("billing.bots")}</span>
                  <input type="number" min={Math.max(1, ws.usage.bots)} max={1000} value={bots} onChange={(e) => setBots(Math.max(1, Number(e.target.value)))} />
                  {botPrice !== undefined && <small className="muted">{t("billing.pricePerBot", { price: money(botPrice) })}</small>}
                </label>
              </div>
              {total !== undefined && (
                <p className="billing-total">{t(interval === "month" ? "billing.totalMonth" : "billing.totalYear", { price: money(total) })}</p>
              )}
              {isAdmin && (
                <button className="btn" disabled={busy || total === undefined} onClick={() => void go("/api/billing/checkout", { interval, builders, bots })}>
                  {t("billing.continue")}
                </button>
              )}
            </>
          )}
        </div>
      )}

      {ws.plan !== "enterprise" && (
        <div className="card billing-card">
          <h2>{t("plan.enterprise")}</h2>
          <p className="muted">{t("billing.enterpriseHelp")}</p>
          {SALES_EMAIL && (
            <a className="btn-ghost" href={`mailto:${SALES_EMAIL}?subject=${encodeURIComponent(`ZamTech AI Enterprise: ${ws.name}`)}`}>
              {t("billing.contact")}
            </a>
          )}
        </div>
      )}
    </>
  );
}
