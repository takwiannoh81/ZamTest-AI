import { useEffect, useRef, useState } from "react";
import type { Workflow } from "@zamtest/core";
import { useI18n } from "@zamtest/i18n/react";
import { api } from "../api";
import { ErrorBanner, Field, Modal } from "./ui";

interface PickPc {
  id: string;
  name: string;
  canPick?: boolean;
  /** Pause on the page and "run the steps before first" (agent 0.3.6). */
  canPickAfterSteps?: boolean;
  /** "Any item like this one" (agent 0.3.7). */
  canPickLists?: boolean;
  version?: string;
}

interface Pick {
  id: string;
  status: "pending" | "recording" | "stopping" | "done" | "failed" | "cancelled";
  error?: string;
  element?: {
    selector: string;
    description: string;
    similar?: { items: string; count: number; inner?: string };
    inside?: { matches: number; total: number };
  };
  /** Running the steps before, or waiting for the click. */
  stage?: "prefix" | "picking";
  /** Why the steps before did not all run. */
  note?: string;
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
  prefix,
  onPicked,
  onClose,
  inside,
}: {
  target: "web" | "desktop";
  /** Web: where the browser opens (the workflow's page before this step). */
  url?: string;
  /** The steps before this one (open the page, log in): run first on the PC when chosen. */
  prefix?: Workflow;
  /** The element; with `list` when the person chose "any item like this one"; with `inside` in inside mode. */
  onPicked: (selector: string, description: string, extra?: { list?: { items: string; count: number; inner?: string }; inside?: { matches: number; total: number } }) => void;
  /** Inside: pick something within the items of this list (e.g. the offline icon, to skip those items). */
  inside?: string;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [pcs, setPcs] = useState<PickPc[]>();
  const [pcId, setPcId] = useState(remembered);
  const [pick, setPick] = useState<Pick>();
  const [message, setMessage] = useState<string>();
  /** Picked, and part of a list: the person chooses this one or any like it. */
  const [choice, setChoice] = useState<NonNullable<Pick["element"]>>();
  const [error, setError] = useState<string>();
  const started = useRef(false);
  const [runBefore, setRunBefore] = useState(Boolean(prefix));
  const before = useRef(runBefore);
  before.current = runBefore;
  const newer = useRef(true);

  const start = async (agentId: string) => {
    setError(undefined);
    setMessage(undefined);
    try {
      remember(agentId);
      const hint = inside ? t("indicate.screenInside") : target === "web" ? t("indicate.screenWeb") : t("indicate.screenDesktop");
      const texts = {
        pick: hint,
        paused: target === "web" ? t("indicate.pausedWeb") : t("indicate.pausedDesktop"),
        pause: t("indicate.pause"),
        resume: t("record.indicate"),
        cancel: t("common.cancel"),
      };
      setPick(
        await api<Pick>("/api/recordings", {
          method: "POST",
          body: {
            agentId,
            kind: "pick",
            target,
            url,
            hint,
            texts,
            prefix: before.current && newer.current ? prefix : undefined,
            mode: inside ? "inside" : undefined,
            items: inside,
          },
        }),
      );
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
        if (!prefix && chosen?.canPick && !started.current && (list.filter((p) => p.canPick).length === 1 || chosen.id === remembered())) {
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
            const el = r.element;
            if (el?.inside) onPicked(el.selector, el.description, { inside: el.inside });
            else if (el?.similar && el.similar.count >= 2) setChoice(el);
            else if (el) onPicked(el.selector, el.description);
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
  newer.current = pc?.canPickAfterSteps !== false;
  if (choice) {
    return (
      <Modal
        title={t("indicate.title")}
        onClose={onClose}
        footer={
          <>
            <button className="btn-ghost" onClick={() => onPicked(choice.selector, choice.description)}>
              {t("indicate.onlyThis")}
            </button>
            <button className="btn" onClick={() => onPicked(choice.selector, choice.description, { list: choice.similar })}>
              {t("indicate.anyLikeThis")}
            </button>
          </>
        }
      >
        <p>
          <strong>{choice.description}</strong>
        </p>
        <p className="muted">{t("indicate.similarFound", { count: choice.similar!.count })}</p>
        <p className="muted tiny">{t("indicate.anyLikeThisHelp")}</p>
      </Modal>
    );
  }

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
        <>
          <p className="fix-status busy">
            <span className="spinner" />
            {pick.stage === "prefix"
              ? t("indicate.runningBefore", { pc: pc?.name ?? "" })
              : target === "web"
                ? t("indicate.waitingWeb", { pc: pc?.name ?? "" })
                : t("indicate.waitingDesktop", { pc: pc?.name ?? "" })}
          </p>
          {pick.note && <p className="warn-text tiny">{t("indicate.beforeFailed", { error: pick.note })}</p>}
        </>
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
          {prefix && (
            <label className="check-row">
              <input type="checkbox" checked={runBefore && pc?.canPickAfterSteps !== false} disabled={pc?.canPickAfterSteps === false} onChange={(e) => setRunBefore(e.target.checked)} />
              <span>{t("indicate.runBefore", { count: prefix.root.slots?.body?.length ?? 0 })}</span>
            </label>
          )}
          {pc?.canPick && pc.canPickAfterSteps === false && <p className="warn-text tiny">{t("indicate.updateForPause", { version: pc.version || "?" })}</p>}
          {pc && !pc.canPick && <p className="muted tiny">{t("indicate.tooOld")}</p>}
          {pcs && !pcs.length && <p className="muted tiny">{t("record.noPcHelp")}</p>}
          {message && <p className="muted">{message}</p>}
        </>
      )}
      <p className="muted tiny">{target === "desktop" ? t("indicate.helpDesktop") : url ? t("indicate.helpWeb", { url }) : t("indicate.helpWebBlank")}</p>
    </Modal>
  );
}
