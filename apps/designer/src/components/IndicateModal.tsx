import { useEffect, useRef, useState } from "react";
import { useI18n } from "@zamtest/i18n/react";
import { api } from "../api";
import { ErrorBanner, Field, Modal } from "./ui";

interface PickPc {
  id: string;
  name: string;
  canPick?: boolean;
}

interface Pick {
  id: string;
  status: "pending" | "recording" | "stopping" | "done" | "failed" | "cancelled";
  error?: string;
  element?: { selector: string; description: string };
}

const PC_KEY = "zamtest.recordPc";
const remembered = () => {
  try {
    return localStorage.getItem(PC_KEY) ?? "";
  } catch {
    return "";
  }
};
const remember = (id: string) => {
  try {
    localStorage.setItem(PC_KEY, id);
  } catch {
    /* storage unavailable */
  }
};

/**
 * Indicate on screen: on a PC with the agent, the person points at the element
 * for a step (in a browser at the step's page, or in a Windows application) and
 * its selector comes back.
 */
export function IndicateModal({
  target,
  url,
  onPicked,
  onClose,
}: {
  target: "web" | "desktop";
  /** Web: where the browser opens (the workflow's page before this step). */
  url?: string;
  onPicked: (selector: string, description: string) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [pcs, setPcs] = useState<PickPc[]>();
  const [pcId, setPcId] = useState(remembered);
  const [pick, setPick] = useState<Pick>();
  const [message, setMessage] = useState<string>();
  const [error, setError] = useState<string>();
  const started = useRef(false);

  const start = async (agentId: string) => {
    setError(undefined);
    setMessage(undefined);
    try {
      remember(agentId);
      const hint = target === "web" ? t("indicate.screenWeb") : t("indicate.screenDesktop");
      setPick(await api<Pick>("/api/recordings", { method: "POST", body: { agentId, kind: "pick", target, url, hint } }));
    } catch (e) {
      setError((e as Error).message);
    }
  };

  useEffect(() => {
    api<PickPc[]>("/api/recordings/agents")
      .then((list) => {
        setPcs(list);
        const chosen = list.find((p) => p.id === remembered() && p.canPick) ?? list.find((p) => p.canPick) ?? list[0];
        setPcId(chosen?.id ?? "");
        // Straight to the PC when it is clear which one.
        if (chosen?.canPick && !started.current && (list.filter((p) => p.canPick).length === 1 || chosen.id === remembered())) {
          started.current = true;
          void start(chosen.id);
        }
      })
      .catch((e: Error) => setError(e.message));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const active = pick && ["pending", "recording", "stopping"].includes(pick.status);
  useEffect(() => {
    if (!pick || !active) return;
    const timer = setInterval(() => {
      api<Pick>(`/api/recordings/${pick.id}`)
        .then((r) => {
          setPick(r);
          if (r.status === "done") {
            if (r.element) onPicked(r.element.selector, r.element.description);
            else setMessage(t("indicate.nothing"));
          } else if (r.status === "failed") setError(r.error ?? t("record.failed"));
        })
        .catch((e: Error) => setError(e.message));
    }, 700);
    return () => clearInterval(timer);
  }, [pick?.id, active]); // eslint-disable-line react-hooks/exhaustive-deps

  const cancel = async () => {
    if (pick && active) await api(`/api/recordings/${pick.id}/cancel`, { method: "POST" }).catch(() => undefined);
    onClose();
  };

  const pc = pcs?.find((p) => p.id === pcId);
  return (
    <Modal
      title={t("indicate.title")}
      onClose={() => void cancel()}
      footer={
        <>
          <button className="btn-ghost" onClick={() => void cancel()}>
            {t("common.cancel")}
          </button>
          {!active && (
            <button className="btn" disabled={!pc?.canPick} onClick={() => void start(pcId)}>
              ◎ {t("record.indicate")}
            </button>
          )}
        </>
      }
    >
      <ErrorBanner error={error} />
      {active ? (
        <p className="fix-status busy">
          <span className="spinner" />
          {target === "web" ? t("indicate.waitingWeb", { pc: pc?.name ?? "" }) : t("indicate.waitingDesktop", { pc: pc?.name ?? "" })}
        </p>
      ) : (
        <>
          <Field label={t("record.pc")}>
            <select value={pcId} onChange={(e) => setPcId(e.target.value)}>
              {!pcs && <option value="">{t("common.loading")}</option>}
              {pcs && !pcs.length && <option value="">{t("record.noPc")}</option>}
              {pcs?.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                  {p.canPick ? "" : ` (${t("record.pcTooOld")})`}
                </option>
              ))}
            </select>
          </Field>
          {pc && !pc.canPick && <p className="muted tiny">{t("indicate.tooOld")}</p>}
          {pcs && !pcs.length && <p className="muted tiny">{t("record.noPcHelp")}</p>}
          {message && <p className="muted">{message}</p>}
        </>
      )}
      <p className="muted tiny">{target === "desktop" ? t("indicate.helpDesktop") : url ? t("indicate.helpWeb", { url }) : t("indicate.helpWebBlank")}</p>
    </Modal>
  );
}
