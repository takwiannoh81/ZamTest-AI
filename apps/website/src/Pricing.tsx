import { useEffect, useState } from "react";
import { useI18n } from "@zamtest/i18n/react";

const PORTAL_URL = import.meta.env.VITE_PORTAL_URL ?? "http://localhost:5173";
const API_URL = (import.meta.env.VITE_AGENT_SERVER_URL ?? "http://localhost:4000").replace(/\/+$/, "");
const SALES_EMAIL = import.meta.env.VITE_SALES_EMAIL as string | undefined;

type Interval = "month" | "year";
interface Pricing {
  configured: boolean;
  prices?: { currency: string; builder: Partial<Record<Interval, number>>; bot: Partial<Record<Interval, number>> };
  included: { free: { builders: number; bots: number; runsPerMonth: number; aiPerMonth: number }; pro: { runsPerBot: number; aiPerBuilder: number } };
}

/** What the plans include when the server cannot be reached (same as the server's defaults). */
const FALLBACK: Pricing = {
  configured: false,
  included: { free: { builders: 1, bots: 1, runsPerMonth: 100, aiPerMonth: 20 }, pro: { runsPerBot: 5000, aiPerBuilder: 500 } },
};

/** Free, Pro and Enterprise side by side; Pro's prices come live from Stripe (through the server). */
export function Pricing() {
  const { t, locale } = useI18n();
  const [data, setData] = useState<Pricing>(FALLBACK);
  const [cycle, setCycle] = useState<Interval>("month");

  useEffect(() => {
    fetch(`${API_URL}/api/public/pricing`)
      .then((r) => (r.ok ? (r.json() as Promise<Pricing>) : FALLBACK))
      .then(setData)
      .catch(() => undefined);
  }, []);

  const prices = data.configured ? data.prices : undefined;
  const hasYearly = Boolean(prices?.builder.year && prices.bot.year);
  const shown: Interval = hasYearly ? cycle : "month";
  const money = (cents: number) =>
    new Intl.NumberFormat(locale, { style: "currency", currency: prices?.currency ?? "usd", maximumFractionDigits: cents % 100 ? 2 : 0 }).format(cents / 100);
  const count = (n: number) => new Intl.NumberFormat(locale).format(n);
  // e.g. $290 a year instead of 12 x $29: 2 months free.
  const monthsFree = prices?.builder.month && prices.builder.year ? Math.round(12 - prices.builder.year / prices.builder.month) : 0;
  const period = t(shown === "month" ? "site.pricing.perMonth" : "site.pricing.perYear");
  const { free, pro } = data.included;

  return (
    <section id="pricing" className="section">
      <div className="wrap">
        <h2>{t("site.pricing.title")}</h2>
        <p className="section-sub">{t("site.pricing.subtitle")}</p>
        {hasYearly && (
          <div className="billing-switch" role="radiogroup" aria-label={t("site.pricing.title")}>
            <button role="radio" aria-checked={cycle === "month"} className={cycle === "month" ? "on" : ""} onClick={() => setCycle("month")}>
              {t("site.pricing.monthly")}
            </button>
            <button role="radio" aria-checked={cycle === "year"} className={cycle === "year" ? "on" : ""} onClick={() => setCycle("year")}>
              {t("site.pricing.yearly")}
              {monthsFree > 0 && <span className="save">{t("site.pricing.monthsFree", { count: monthsFree })}</span>}
            </button>
          </div>
        )}
        <div className="plans">
          <article className="plan">
            <h3>{t("site.pricing.free.name")}</h3>
            <p className="plan-price">
              <strong>{money(0)}</strong> <span>{t("site.pricing.free.period")}</span>
            </p>
            <ul>
              <li>{t("site.pricing.free.seats", { builders: free.builders, bots: free.bots })}</li>
              <li>{t("site.pricing.free.usage", { runs: count(free.runsPerMonth), ai: count(free.aiPerMonth) })}</li>
              <li>{t("site.pricing.free.apps")}</li>
            </ul>
            <a className="btn btn-ghost" href={`${PORTAL_URL}/?signup=1`}>
              {t("site.pricing.free.button")}
            </a>
          </article>

          <article className="plan plan-featured">
            <span className="plan-badge">{t("site.pricing.pro.badge")}</span>
            <h3>{t("site.pricing.pro.name")}</h3>
            {prices?.builder[shown] && prices.bot[shown] ? (
              <p className="plan-price">
                <strong>{money(prices.builder[shown]!)}</strong> <span>{t("site.pricing.pro.perBuilder", { period })}</span>
                <small>{t("site.pricing.pro.plusBot", { price: money(prices.bot[shown]!), period })}</small>
              </p>
            ) : (
              <p className="plan-price">
                <span>{t("site.pricing.pro.perSeat")}</span>
              </p>
            )}
            <ul>
              <li>{t("site.pricing.pro.runs", { runs: count(pro.runsPerBot) })}</li>
              <li>{t("site.pricing.pro.ai", { ai: count(pro.aiPerBuilder) })}</li>
              <li>{t("site.pricing.pro.schedules")}</li>
              <li>{t("site.pricing.pro.cicd")}</li>
              <li>{t("site.pricing.pro.everything")}</li>
            </ul>
            <a className="btn" href={`${PORTAL_URL}/?signup=1`}>
              {t("site.pricing.pro.button")}
            </a>
            <p className="plan-note">{t("site.pricing.pro.note")}</p>
          </article>

          <article className="plan">
            <h3>{t("site.pricing.enterprise.name")}</h3>
            <p className="plan-price">
              <strong>{t("site.pricing.enterprise.price")}</strong> <span>{t("site.pricing.enterprise.period")}</span>
            </p>
            <ul>
              <li>{t("site.pricing.enterprise.sso")}</li>
              <li>{t("site.pricing.enterprise.rollout")}</li>
              <li>{t("site.pricing.enterprise.limits")}</li>
              <li>{t("site.pricing.enterprise.invoice")}</li>
            </ul>
            <a className="btn btn-ghost" href={SALES_EMAIL ? `mailto:${SALES_EMAIL}?subject=${encodeURIComponent("ZamTech AI Enterprise")}` : `${PORTAL_URL}/?signup=1`}>
              {SALES_EMAIL ? t("site.pricing.enterprise.button") : t("site.cta.button")}
            </a>
          </article>
        </div>
        <p className="plans-foot">{t("site.pricing.builderHelp")}</p>
      </div>
    </section>
  );
}
