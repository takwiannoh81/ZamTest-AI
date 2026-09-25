import { useEffect, useRef, useState } from "react";
import type { Step, VariableDef } from "@zamtest/core";
import { useI18n } from "@zamtest/i18n/react";
import { api } from "../api";
import { ErrorBanner, Field, Modal } from "./ui";

interface RecordingPc {
  id: string;
  name: string;
  machine: string;
  os: string;
  canRecord: boolean;
  /** The PC's agent can let the person click the application to record. */
  canIndicate?: boolean;
}

interface Recording {
  id: string;
  agentName: string;
  status: "pending" | "recording" | "stopping" | "done" | "failed" | "cancelled";
  steps: Step[];
  variables: VariableDef[];
  error?: string;
  /** Indicate: the application clicked on the PC. */
  picked?: { path: string; process: string; title: string };
}

const PC_KEY = "zamtest.recordPc";
const remember = (id: string) => {
  try {
    localStorage.setItem(PC_KEY, id);
  } catch {
    /* storage unavailable */
  }
};
const remembered = () => {
  try {
    return localStorage.getItem(PC_KEY) ?? "";
  } catch {
    return "";
  }
};

/**
 * Records on a PC (the person's own, with the ZamTech AI agent running): a
 * browser at an address, or a Windows program. The steps appear here as they are
 * recorded; Stop puts them into the workflow at the selected place. For a
 * program, "Indicate" lets the person click it on the PC instead of typing its path.
 */
export function RecordModal({
  describe,
  onInsert,
  onClose,
}: {
  describe: (step: Step) => string;
  onInsert: (steps: Step[], variables: VariableDef[]) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [pcs, setPcs] = useState<RecordingPc[]>();
  const [pcId, setPcId] = useState(remembered);
  const [kind, setKind] = useState<"web" | "desktop">("web");
  const [url, setUrl] = useState("https://");
  const [program, setProgram] = useState("");
  /** The program was indicated: it is open already, so the recording does not start it again. */
  const [attach, setAttach] = useState(false);
  const [indicating, setIndicating] = useState<Recording>();
  const [indicated, setIndicated] = useState<string>();
  const [recording, setRecording] = useState<Recording>();
  const [error, setError] = useState<string>();
  const inserted = useRef(false);

  useEffect(() => {
    api<RecordingPc[]>("/api/recordings/agents")
      .then((list) => {
        setPcs(list);
        // Keep the PC used last time; otherwise the first one that can record.
        setPcId((current) => (list.some((p) => p.id === current) ? current : (list.find((p) => p.canRecord) ?? list[0])?.id ?? ""));
      })
      .catch((e: Error) => setError(e.message));
  }, []);

  // Follow the recording while it runs; when it is done, its steps go into the workflow.
  const active = recording && ["pending", "recording", "stopping"].includes(recording.status);
  useEffect(() => {
    if (!recording || !active) return;
    const timer = setInterval(() => {
      api<Recording>(`/api/recordings/${recording.id}`)
        .then(setRecording)
        .catch((e: Error) => setError(e.message));
    }, 1000);
    return () => clearInterval(timer);
  }, [recording?.id, active]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (recording?.status === "done" && !inserted.current) {
      inserted.current = true;
      onInsert(recording.steps, recording.variables);
    }
  }, [recording, onInsert]);

  // Indicate: wait for the person to click the application on the PC.
  const pointing = indicating && ["pending", "recording", "stopping"].includes(indicating.status);
  useEffect(() => {
    if (!indicating || !pointing) return;
    const timer = setInterval(() => {
      api<Recording>(`/api/recordings/${indicating.id}`)
        .then((r) => {
          setIndicating(r);
          if (r.status === "done") {
            if (r.picked) {
              setProgram(r.picked.path || `${r.picked.process}.exe`);
              setAttach(true);
              setIndicated(t("record.indicated", { app: r.picked.title || r.picked.process }));
            } else setIndicated(t("record.indicateNone"));
          } else if (r.status === "failed") setError(r.error ?? t("record.failed"));
        })
        .catch((e: Error) => setError(e.message));
    }, 700);
    return () => clearInterval(timer);
  }, [indicating?.id, pointing]); // eslint-disable-line react-hooks/exhaustive-deps

  const indicate = async () => {
    setError(undefined);
    setIndicated(undefined);
    try {
      remember(pcId);
      setIndicating(await api<Recording>("/api/recordings", { method: "POST", body: { agentId: pcId, kind: "indicate", hint: t("record.indicateScreen") } }));
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const stopIndicating = () => {
    if (indicating && pointing) void api(`/api/recordings/${indicating.id}/cancel`, { method: "POST" }).catch(() => undefined);
    setIndicating(undefined);
  };

  const start = async () => {
    setError(undefined);
    try {
      remember(pcId);
      const started = await api<Recording>("/api/recordings", {
        method: "POST",
        body: {
          agentId: pcId,
          kind,
          url: kind === "web" ? url : undefined,
          program: kind === "desktop" ? program || undefined : undefined,
          attach: kind === "desktop" && program ? attach : undefined,
        },
      });
      setRecording(started);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const stop = () => recording && api<Recording>(`/api/recordings/${recording.id}/stop`, { method: "POST" }).then(setRecording, (e: Error) => setError(e.message));
  const cancel = async () => {
    if (recording && active) await api(`/api/recordings/${recording.id}/cancel`, { method: "POST" }).catch(() => undefined);
    stopIndicating();
    onClose();
  };

  const pc = pcs?.find((p) => p.id === pcId);
  const statusText = recording
    ? {
        pending: t("record.waiting", { pc: recording.agentName }),
        recording: kind === "web" ? t("record.recordingWeb", { pc: recording.agentName }) : t("record.recordingDesktop", { pc: recording.agentName }),
        stopping: t("record.stopping"),
        done: t("record.done", { count: recording.steps.length }),
        failed: recording.error ?? t("record.failed"),
        cancelled: t("record.cancelled"),
      }[recording.status]
    : undefined;

  return (
    <Modal
      title={t("record.title")}
      onClose={() => void cancel()}
      footer={
        recording ? (
          <>
            <button className="btn-ghost" onClick={() => void cancel()}>
              {active ? t("common.cancel") : t("common.close")}
            </button>
            {active && (
              <button className="btn danger" disabled={recording.status !== "recording"} onClick={() => void stop()}>
                ■ {t("record.stop")}
              </button>
            )}
          </>
        ) : (
          <>
            <button className="btn-ghost" onClick={() => void cancel()}>
              {t("common.cancel")}
            </button>
            <button className="btn" disabled={!pcId || pointing || (kind === "web" && url.trim().length < 9)} onClick={() => void start()}>
              ● {t("record.start")}
            </button>
          </>
        )
      }
    >
      <ErrorBanner error={error} />
      {!recording ? (
        <>
          <div className="segmented">
            <button className={kind === "web" ? "on" : ""} onClick={() => setKind("web")}>
              {t("record.web")}
            </button>
            <button className={kind === "desktop" ? "on" : ""} onClick={() => setKind("desktop")}>
              {t("record.desktop")}
            </button>
          </div>
          {kind === "web" ? (
            <Field label={t("record.url")}>
              <input value={url} autoFocus onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com" />
            </Field>
          ) : (
            <>
              <Field label={t("record.program")} hint={t("record.programHint")}>
                <div className="indicate-row">
                  <input
                    value={program}
                    autoFocus
                    onChange={(e) => {
                      setProgram(e.target.value);
                      setAttach(false);
                      setIndicated(undefined);
                    }}
                    placeholder="notepad.exe"
                  />
                  <button
                    type="button"
                    className="btn-ghost indicate-btn"
                    disabled={!pcId || pointing || pc?.canIndicate === false}
                    title={pc?.canIndicate === false ? t("record.indicateTooOld") : t("record.indicateHint")}
                    onClick={() => void indicate()}
                  >
                    ◎ {t("record.indicate")}
                  </button>
                </div>
              </Field>
              {pointing && (
                <p className="indicate-status">
                  {t("record.indicating", { pc: indicating.agentName })}{" "}
                  <button type="button" className="link-btn" onClick={stopIndicating}>
                    {t("common.cancel")}
                  </button>
                </p>
              )}
              {!pointing && indicated && <p className="muted tiny">{indicated}</p>}
              {pc?.canIndicate === false && pc.canRecord && <p className="muted tiny">{t("record.indicateTooOld")}</p>}
            </>
          )}
          <Field label={t("record.pc")}>
            <select value={pcId} onChange={(e) => setPcId(e.target.value)}>
              {!pcs?.length && <option value="">{t("record.noPc")}</option>}
              {pcs?.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                  {p.canRecord ? "" : ` (${t("record.pcTooOld")})`}
                </option>
              ))}
            </select>
          </Field>
          {pc && !pc.canRecord && <p className="muted tiny">{t("record.pcTooOldHelp")}</p>}
          {!pcs?.length && pcs && <p className="muted tiny">{t("record.noPcHelp")}</p>}
        </>
      ) : (
        <>
          <p className={recording.status === "failed" ? "error-text" : "muted"}>{statusText}</p>
          <ol className="recorded-steps">
            {recording.steps.map((s) => (
              <li key={s.id}>{describe(s)}</li>
            ))}
          </ol>
          {active && !recording.steps.length && <p className="muted tiny">{t("record.noStepsYet")}</p>}
        </>
      )}
    </Modal>
  );
}
