import { useI18n } from "@zamtest/i18n/react";
import type { MessageKey } from "@zamtest/i18n";
import QRCode from "qrcode";
import { useEffect, useState } from "react";
import { api, BASE } from "../api";
import { usePoll } from "../hooks";
import { atLeast, useMe } from "../session";
import type { Role } from "../session";
import { ErrorBanner, PageHeader } from "../ui";

interface MfaStatus {
  enabled: boolean;
  required: boolean;
  recoveryCodesLeft: number;
}

interface SsoView {
  available: boolean;
  domains: string[];
  redirectUri: string;
  settings: { enabled: boolean; issuer: string; clientId: string; secretSet: boolean; defaultRole: Role; autoProvision: boolean; enforce: boolean };
}

/** How people sign in (two-step, company sign-in) and the workspace's data export. */
export function Security() {
  const { t } = useI18n();
  const me = useMe();
  const isAdmin = atLeast(me, "admin");
  return (
    <>
      <PageHeader title={t("nav.security")} subtitle={t("security.subtitle")} />
      {me?.kind === "user" && <MfaCard />}
      {isAdmin && <RequireMfaCard />}
      {isAdmin && <SsoCard />}
      {isAdmin && (
        <div className="card">
          <h2>{t("security.exportTitle")}</h2>
          <p className="muted">{t("security.exportHelp")}</p>
          <a className="btn-ghost" href={`${BASE}/api/workspace/export`}>
            {t("security.exportButton")}
          </a>
        </div>
      )}
    </>
  );
}

/** Two-step sign-in for your own account: set up with a QR code, recovery codes, turn off. */
export function MfaCard({ onEnabled }: { onEnabled?: () => void }) {
  const { t } = useI18n();
  const { data: status, reload } = usePoll<MfaStatus>("/api/auth/mfa", 0);
  const [setup, setSetup] = useState<{ secret: string; qr: string }>();
  const [code, setCode] = useState("");
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>();
  const [error, setError] = useState<string>();

  const run = async (action: () => Promise<void>) => {
    setError(undefined);
    try {
      await action();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const start = () =>
    run(async () => {
      const { secret, otpauthUrl } = await api<{ secret: string; otpauthUrl: string }>("/api/auth/mfa/setup", { method: "POST" });
      setSetup({ secret, qr: await QRCode.toDataURL(otpauthUrl, { margin: 1, width: 200 }) });
      setCode("");
    });
  const enable = () =>
    run(async () => {
      const { recoveryCodes: codes } = await api<{ recoveryCodes: string[] }>("/api/auth/mfa/enable", { method: "POST", body: { code: code.trim() } });
      setSetup(undefined);
      setRecoveryCodes(codes);
      reload();
    });
  const newCodes = () =>
    run(async () => {
      const current = window.prompt(t("auth.mfaHelp"));
      if (!current) return;
      const { recoveryCodes: codes } = await api<{ recoveryCodes: string[] }>("/api/auth/mfa/recovery-codes", { method: "POST", body: { code: current.trim() } });
      setRecoveryCodes(codes);
      reload();
    });
  const disable = () =>
    run(async () => {
      const password = window.prompt(t("security.mfaDisablePrompt"));
      if (!password) return;
      await api("/api/auth/mfa/disable", { method: "POST", body: { password } });
      reload();
    });
  const download = () => {
    const blob = new Blob([`ZamTech AI recovery codes\n\n${recoveryCodes!.join("\n")}\n`], { type: "text/plain" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = "zamtech-ai-recovery-codes.txt";
    link.click();
    URL.revokeObjectURL(link.href);
  };

  return (
    <div className="card">
      <h2>{t("auth.mfaTitle")}</h2>
      <ErrorBanner error={error} />
      {recoveryCodes ? (
        <>
          <h3 className="card-sub">{t("security.recoveryTitle")}</h3>
          <p className="notice">{t("security.recoveryHelp")}</p>
          <ul className="recovery-codes">
            {recoveryCodes.map((c) => (
              <li key={c}>
                <code>{c}</code>
              </li>
            ))}
          </ul>
          <div className="actions">
            <button className="btn-ghost" onClick={download}>
              {t("security.recoveryDownload")}
            </button>
            <button
              className="btn"
              onClick={() => {
                setRecoveryCodes(undefined);
                onEnabled?.();
              }}
            >
              {t("verify.continue")}
            </button>
          </div>
        </>
      ) : setup ? (
        <>
          <p className="muted">{t("security.mfaScan")}</p>
          <div className="mfa-setup">
            <img src={setup.qr} alt="QR code" width={200} height={200} />
            <div>
              <p className="muted small">{t("security.mfaSecret", { secret: setup.secret.replace(/(.{4})/g, "$1 ").trim() })}</p>
              <label className="field">
                <span>{t("auth.mfaCode")}</span>
                <input className="code-input" inputMode="numeric" autoComplete="one-time-code" placeholder="123456" value={code} onChange={(e) => setCode(e.target.value)} />
              </label>
              <button className="btn" disabled={code.trim().length < 6} onClick={() => void enable()}>
                {t("security.mfaConfirm")}
              </button>
            </div>
          </div>
        </>
      ) : status?.enabled ? (
        <>
          <p>{t("security.mfaOn", { count: status.recoveryCodesLeft })}</p>
          <div className="actions">
            <button className="btn-ghost" onClick={() => void newCodes()}>
              {t("security.recoveryNew")}
            </button>
            {!status.required && (
              <button className="btn-ghost danger" onClick={() => void disable()}>
                {t("security.mfaDisable")}
              </button>
            )}
          </div>
        </>
      ) : (
        status && (
          <>
            <p className="muted">{t("security.mfaOff")}</p>
            <button className="btn" onClick={() => void start()}>
              {t("security.mfaSetup")}
            </button>
          </>
        )
      )}
    </div>
  );
}

function RequireMfaCard() {
  const { t } = useI18n();
  const { data, reload } = usePoll<{ requireMfa?: boolean }>("/api/workspace/security", 0);
  const [error, setError] = useState<string>();
  const toggle = async (requireMfa: boolean) => {
    setError(undefined);
    try {
      await api("/api/workspace/security", { method: "PUT", body: { requireMfa } });
      reload();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  if (!data) return null;
  return (
    <div className="card">
      <ErrorBanner error={error} />
      <label className="toggle">
        <input type="checkbox" checked={Boolean(data.requireMfa)} onChange={(e) => void toggle(e.target.checked)} />
        <strong>{t("security.requireMfa")}</strong>
      </label>
      <p className="muted small">{t("security.requireMfaHelp")}</p>
    </div>
  );
}

const ROLES: Role[] = ["viewer", "operator", "developer", "admin"];

function SsoCard() {
  const { t } = useI18n();
  const { data, reload } = usePoll<SsoView>("/api/workspace/sso", 0);
  const [form, setForm] = useState<SsoView["settings"] & { clientSecret: string }>();
  const [error, setError] = useState<string>();
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (data && !form) setForm({ ...data.settings, clientSecret: "" });
  }, [data, form]);

  if (!data || !form) return null;
  if (!data.available) {
    return (
      <div className="card">
        <h2>{t("security.ssoTitle")}</h2>
        <p className="muted">{t("security.ssoEnterprise")}</p>
      </div>
    );
  }

  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) => {
    setSaved(false);
    setForm({ ...form, [key]: value });
  };
  const save = async () => {
    setError(undefined);
    try {
      await api("/api/workspace/sso", {
        method: "PUT",
        body: {
          enabled: form.enabled,
          issuer: form.issuer.trim(),
          clientId: form.clientId.trim(),
          ...(form.clientSecret ? { clientSecret: form.clientSecret } : {}),
          defaultRole: form.defaultRole,
          autoProvision: form.autoProvision,
          enforce: form.enforce,
        },
      });
      setSaved(true);
      setForm(undefined);
      reload();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div className="card sso-card">
      <h2>{t("security.ssoTitle")}</h2>
      <p className="muted">{t("security.ssoEnterprise")}</p>
      <ErrorBanner error={error} />
      <div className="field">
        <span>{t("security.ssoDomains")}</span>
        {data.domains.length ? <strong>{data.domains.join(", ")}</strong> : <span className="muted">{t("security.ssoNoDomains")}</span>}
      </div>
      <div className="field">
        <span>{t("security.ssoRedirect")}</span>
        <code className="copyable">{data.redirectUri}</code>
      </div>
      <label className="field">
        <span>{t("security.ssoIssuer")}</span>
        <input value={form.issuer} placeholder="https://login.microsoftonline.com/<tenant>/v2.0" onChange={(e) => set("issuer", e.target.value)} />
      </label>
      <label className="field">
        <span>{t("security.ssoClientId")}</span>
        <input value={form.clientId} onChange={(e) => set("clientId", e.target.value)} />
      </label>
      <label className="field">
        <span>{t("security.ssoClientSecret")}</span>
        <input
          type="password"
          autoComplete="off"
          value={form.clientSecret}
          placeholder={form.secretSet ? t("security.ssoSecretSaved") : ""}
          onChange={(e) => set("clientSecret", e.target.value)}
        />
      </label>
      <label className="field">
        <span>{t("security.ssoDefaultRole")}</span>
        <select value={form.defaultRole} onChange={(e) => set("defaultRole", e.target.value as Role)}>
          {ROLES.map((r) => (
            <option key={r} value={r}>
              {t(`role.${r}` as MessageKey)}
            </option>
          ))}
        </select>
      </label>
      <label className="toggle">
        <input type="checkbox" checked={form.autoProvision} onChange={(e) => set("autoProvision", e.target.checked)} />
        {t("security.ssoAutoProvision")}
      </label>
      <label className="toggle">
        <input type="checkbox" checked={form.enforce} onChange={(e) => set("enforce", e.target.checked)} />
        {t("security.ssoEnforce")}
      </label>
      <label className="toggle">
        <input type="checkbox" checked={form.enabled} onChange={(e) => set("enabled", e.target.checked)} />
        <strong>{t("security.ssoEnable")}</strong>
      </label>
      <div className="actions">
        <button className="btn" onClick={() => void save()}>
          {t("common.save")}
        </button>
        {saved && <span className="muted">{t("security.saved")}</span>}
      </div>
    </div>
  );
}
