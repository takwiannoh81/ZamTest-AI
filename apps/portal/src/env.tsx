import { useI18n } from "@zamtest/i18n/react";
import type { MessageKey } from "@zamtest/i18n";
import type { EnvironmentId, EnvironmentsView } from "./api";
import { ENVIRONMENT_IDS } from "./api";
import { usePoll } from "./hooks";

export const envName = (t: (k: MessageKey) => string, env: EnvironmentId) => t(`env.${env}` as MessageKey);

/** Whether the workspace uses Development, Test and Production. */
export function useEnvironmentsOn(): boolean {
  return Boolean(usePoll<EnvironmentsView>("/api/environments", 0).data?.enabled);
}

/** Picks an environment; with `anyLabel`, also "every environment" (value ""). */
export function EnvironmentSelect({
  value,
  onChange,
  anyLabel,
  disabled,
}: {
  value: EnvironmentId | "";
  onChange: (value: EnvironmentId | "") => void;
  anyLabel?: string;
  disabled?: boolean;
}) {
  const { t } = useI18n();
  return (
    <select value={value} disabled={disabled} onChange={(e) => onChange(e.target.value as EnvironmentId | "")}>
      {anyLabel && <option value="">{anyLabel}</option>}
      {ENVIRONMENT_IDS.map((id) => (
        <option key={id} value={id}>
          {envName(t, id)}
        </option>
      ))}
    </select>
  );
}

export function EnvironmentBadge({ env }: { env: EnvironmentId }) {
  const { t } = useI18n();
  return <span className={`env-badge env-${env}`}>{envName(t, env)}</span>;
}
