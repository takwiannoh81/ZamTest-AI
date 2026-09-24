import { LOCALES } from "@zamtest/i18n";
import type { MessageKey } from "@zamtest/i18n";
import { LanguageSelect, ThemeSelect, useI18n } from "@zamtest/i18n/react";
import { Pricing } from "./Pricing";

const PORTAL_URL = import.meta.env.VITE_PORTAL_URL ?? "http://localhost:5173";
const DESIGNER_URL = import.meta.env.VITE_DESIGNER_URL ?? "http://localhost:5174";

type Card = { icon: string; title: MessageKey; text: MessageKey };

const FEATURES: Card[] = [
  { icon: "🧩", title: "site.features.designer.title", text: "site.features.designer.text" },
  { icon: "🎛", title: "site.features.portal.title", text: "site.features.portal.text" },
  { icon: "🤖", title: "site.features.agents.title", text: "site.features.agents.text" },
  { icon: "🌐", title: "site.features.browser.title", text: "site.features.browser.text" },
];

const AI: Card[] = [
  { icon: "✨", title: "site.ai.build.title", text: "site.ai.build.text" },
  { icon: "🩹", title: "site.ai.heal.title", text: "site.ai.heal.text" },
  { icon: "🧠", title: "site.ai.agents.title", text: "site.ai.agents.text" },
  { icon: "📄", title: "site.ai.extract.title", text: "site.ai.extract.text" },
];

const STEPS: Array<{ title: MessageKey; text: MessageKey }> = [
  { title: "site.how.step1.title", text: "site.how.step1.text" },
  { title: "site.how.step2.title", text: "site.how.step2.text" },
  { title: "site.how.step3.title", text: "site.how.step3.text" },
];

function Cards({ cards }: { cards: Card[] }) {
  const { t } = useI18n();
  return (
    <div className="cards">
      {cards.map((c) => (
        <article className="card" key={c.title}>
          <span className="card-icon" aria-hidden>
            {c.icon}
          </span>
          <h3>{t(c.title)}</h3>
          <p>{t(c.text)}</p>
        </article>
      ))}
    </div>
  );
}

export function Site() {
  const { t } = useI18n();

  return (
    <>
      <header className="header">
        <div className="wrap header-inner">
          <a className="brand" href="#top">
            <img src="/favicon.svg" alt="" width={32} height={32} />
            <strong>ZamTech AI</strong>
          </a>
          <nav className="nav">
            <a href="#features">{t("site.nav.features")}</a>
            <a href="#ai">{t("site.nav.ai")}</a>
            <a href="#pricing">{t("site.nav.pricing")}</a>
            <a href="#languages">{t("site.nav.languages")}</a>
          </nav>
          <div className="header-actions">
            <LanguageSelect className="lang" />
            <ThemeSelect className="lang" />
            <a className="btn btn-small" href={PORTAL_URL}>
              {t("site.nav.signIn")}
            </a>
          </div>
        </div>
      </header>

      <main id="top">
        <section className="hero">
          <div className="wrap hero-inner">
            <div className="hero-copy">
              <span className="pill">{t("site.hero.badge")}</span>
              <h1>{t("site.hero.title")}</h1>
              <p className="lead">{t("site.hero.subtitle")}</p>
              <div className="hero-cta">
                <a className="btn" href={PORTAL_URL}>
                  {t("site.hero.primary")}
                </a>
                <a className="btn btn-ghost" href={DESIGNER_URL}>
                  {t("site.hero.secondary")}
                </a>
              </div>
            </div>
            <div className="hero-shot">
              <div className="window">
                <div className="window-bar" aria-hidden>
                  <span />
                  <span />
                  <span />
                </div>
                <img src="/designer.png" alt={t("site.features.designer.title")} width={1440} height={900} />
              </div>
            </div>
          </div>
        </section>

        <section id="features" className="section">
          <div className="wrap">
            <h2>{t("site.features.title")}</h2>
            <Cards cards={FEATURES} />
          </div>
        </section>

        <section id="ai" className="section section-alt">
          <div className="wrap">
            <h2>{t("site.ai.title")}</h2>
            <p className="section-sub">{t("site.ai.subtitle")}</p>
            <Cards cards={AI} />
          </div>
        </section>

        <section className="section">
          <div className="wrap">
            <h2>{t("site.how.title")}</h2>
            <ol className="steps">
              {STEPS.map((s, i) => (
                <li key={s.title}>
                  <span className="step-num">{i + 1}</span>
                  <h3>{t(s.title)}</h3>
                  <p>{t(s.text)}</p>
                </li>
              ))}
            </ol>
          </div>
        </section>

        <Pricing />

        <section id="languages" className="section section-alt">
          <div className="wrap">
            <h2>{t("site.languages.title")}</h2>
            <p className="section-sub">{t("site.languages.text", { count: LOCALES.length })}</p>
            <ul className="langs">
              {LOCALES.map((l) => (
                <li key={l.code} lang={l.code} dir={"dir" in l ? l.dir : undefined}>
                  {l.name}
                </li>
              ))}
            </ul>
          </div>
        </section>

        <section className="section">
          <div className="wrap cta">
            <h2>{t("site.cta.title")}</h2>
            <p>{t("site.cta.text")}</p>
            <a className="btn" href={`${PORTAL_URL}/?signup=1`}>
              {t("site.cta.button")}
            </a>
          </div>
        </section>
      </main>

      <footer className="footer">
        <div className="wrap footer-inner">
          <span>{t("site.footer.rights", { year: new Date().getFullYear() })}</span>
          <span className="footer-links">
            <a href={PORTAL_URL}>Portal</a>
            <a href={DESIGNER_URL}>Designer</a>
          </span>
        </div>
      </footer>
    </>
  );
}
