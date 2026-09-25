import { useEffect, useRef, useState } from "react";
import type { Step, Workflow } from "@zamtest/core";
import { currentLocale, useI18n } from "@zamtest/i18n/react";
import { api } from "../api";
import type { WorkflowSummary } from "../api";
import { ErrorBanner, Field, Modal } from "./ui";

interface Pc {
  id: string;
  name: string;
  canExplore?: boolean;
  version?: string;
}
interface Folder {
  id: string;
  name: string;
  parentId?: string;
}
interface CaseRef {
  id: string;
  name: string;
  workflowId?: string;
}
interface Explore {
  id: string;
  status: "pending" | "recording" | "stopping" | "done" | "failed" | "cancelled";
  stage?: "prefix" | "waiting" | "exploring";
  note?: string;
  error?: string;
  explored?: { pages: Array<{ url: string; title: string; beforeSignIn?: boolean }> };
}
interface Proposal {
  name: string;
  description: string;
  page?: string;
  definition: Workflow;
}
type SignIn = "none" | "steps" | "self";

const PC_KEY = "zamtest.recordPc";
const remembered = () => {
  try {
    return localStorage.getItem(PC_KEY) ?? "";
  } catch {
    return "";
  }
};

const labels = (steps: Step[]): string[] => steps.flatMap((s) => [s.label || s.type, ...Object.values(s.slots ?? {}).flatMap(labels)]);

/**
 * Generate tests with AI: the agent explores the website on a PC (after signing
 * in), AI writes test cases from the pages it found, and the person keeps the
 * ones they want.
 */
export function GenerateTestsModal({
  workflows,
  cases,
  folders,
  folderId: initialFolder,
  onClose,
  onCreated,
}: {
  workflows: WorkflowSummary[];
  cases: CaseRef[];
  folders: Folder[];
  folderId?: string;
  onClose: () => void;
  onCreated: (ids: string[], run: boolean) => void;
}) {
  const { t } = useI18n();
  const [pcs, setPcs] = useState<Pc[]>();
  const [pcId, setPcId] = useState(remembered);
  const [url, setUrl] = useState("");
  const [signIn, setSignIn] = useState<SignIn>("none");
  const [stepsFrom, setStepsFrom] = useState("");
  const [asset, setAsset] = useState("");
  const [assets, setAssets] = useState<Array<{ name: string; type: string }>>([]);
  const [focus, setFocus] = useState("");
  const [count, setCount] = useState(8);
  const [maxPages, setMaxPages] = useState(8);
  const [folderId, setFolderId] = useState(initialFolder ?? "");
  const [explore, setExplore] = useState<Explore>();
  const [writing, setWriting] = useState(false);
  const [proposals, setProposals] = useState<Proposal[]>();
  const [notes, setNotes] = useState("");
  const [chosen, setChosen] = useState<Set<number>>(new Set());
  const [runNow, setRunNow] = useState(true);
  const [error, setError] = useState<string>();
  const [creating, setCreating] = useState(false);
  const wrote = useRef<string | undefined>(undefined);

  useEffect(() => {
    api<Pc[]>("/api/recordings/agents")
      .then((list) => {
        setPcs(list);
        const pick = list.find((p) => p.id === remembered() && p.canExplore) ?? list.find((p) => p.canExplore) ?? list[0];
        setPcId(pick?.id ?? "");
      })
      .catch((e: Error) => setError(e.message));
    api<Array<{ name: string; type: string }>>("/api/assets")
      .then((list) => setAssets(list.filter((a) => a.type === "credential")))
      .catch(() => undefined);
  }, []);

  const pc = pcs?.find((p) => p.id === pcId);
  const exploring = explore && ["pending", "recording", "stopping"].includes(explore.status);

  // Follow the exploration; when it is done, AI writes the tests.
  useEffect(() => {
    if (!explore || !exploring) return;
    const timer = setInterval(() => {
      api<Explore>(`/api/recordings/${explore.id}`)
        .then(setExplore)
        .catch((e: Error) => setError(e.message));
    }, 1500);
    return () => clearInterval(timer);
  }, [explore?.id, exploring]); // eslint-disable-line react-hooks/exhaustive-deps

  const [kind, sourceId] = stepsFrom.split(":");
  const write = async (exploreId: string) => {
    setWriting(true);
    setError(undefined);
    try {
      const result = await api<{ tests: Proposal[]; notes: string }>("/api/ai/generate-tests", {
        method: "POST",
        body: {
          exploreId,
          focus: focus.trim() || undefined,
          count,
          language: currentLocale(),
          signIn:
            signIn === "steps"
              ? { kind: "steps", ...(kind === "wf" ? { workflowId: sourceId } : { testCaseId: sourceId }) }
              : signIn === "self" && asset
                ? { kind: "asset", asset }
                : { kind: "none" },
        },
      });
      setProposals(result.tests);
      setNotes(result.notes);
      setChosen(new Set(result.tests.map((_, i) => i)));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setWriting(false);
    }
  };
  useEffect(() => {
    if (explore?.status === "done" && wrote.current !== explore.id) {
      wrote.current = explore.id;
      void write(explore.id);
    }
    if (explore?.status === "failed") setError(explore.error ?? t("genTests.failed"));
  }, [explore?.status]); // eslint-disable-line react-hooks/exhaustive-deps

  const start = async () => {
    setError(undefined);
    setProposals(undefined);
    try {
      try {
        localStorage.setItem(PC_KEY, pcId);
      } catch {
        /* storage unavailable */
      }
      let prefix: Workflow | undefined;
      if (signIn === "steps") {
        if (!sourceId) throw new Error(t("genTests.chooseSteps"));
        prefix = kind === "wf" ? (await api<{ definition: Workflow }>(`/api/workflows/${sourceId}`)).definition : (await api<{ definition: Workflow }>(`/api/test-cases/${sourceId}`)).definition;
      }
      setExplore(
        await api<Explore>("/api/recordings", {
          method: "POST",
          body: {
            agentId: pcId,
            kind: "explore",
            url: url.trim() || undefined,
            prefix,
            waitForPerson: signIn === "self",
            maxPages,
            texts: { wait: t("genTests.bannerWait"), start: t("genTests.bannerStart") },
          },
        }),
      );
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const cancel = async () => {
    if (explore && exploring) await api(`/api/recordings/${explore.id}/cancel`, { method: "POST" }).catch(() => undefined);
    onClose();
  };

  const create = async () => {
    if (!proposals) return;
    setCreating(true);
    setError(undefined);
    try {
      const ids: string[] = [];
      for (const i of [...chosen].sort((a, b) => a - b)) {
        const p = proposals[i]!;
        const created = await api<{ id: string }>("/api/test-cases", {
          method: "POST",
          body: { name: p.name, description: p.description || undefined, folderId: folderId || undefined, definition: p.definition },
        });
        ids.push(created.id);
      }
      onCreated(ids, runNow);
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setCreating(false);
    }
  };

  const pathOf = (id?: string): string => {
    const f = folders.find((x) => x.id === id);
    return f ? (f.parentId ? `${pathOf(f.parentId)} / ${f.name}` : f.name) : "";
  };
  const canStart = Boolean(pc?.canExplore) && (url.trim() || (signIn === "steps" && sourceId)) && (signIn !== "steps" || sourceId);
  const pagesFound = explore?.explored?.pages.filter((p) => !p.beforeSignIn).length ?? 0;

  let body;
  if (proposals) {
    body = (
      <>
        <p className="muted small">{t("genTests.review", { count: proposals.length })}</p>
        {notes && (
          <details className="gen-notes">
            <summary>{t("genTests.notes")}</summary>
            <p className="small">{notes}</p>
          </details>
        )}
        <div className="gen-list">
          {proposals.map((p, i) => (
            <label key={i} className="gen-item">
              <input
                type="checkbox"
                checked={chosen.has(i)}
                onChange={(e) => {
                  const next = new Set(chosen);
                  if (e.target.checked) next.add(i);
                  else next.delete(i);
                  setChosen(next);
                }}
              />
              <div>
                <strong>{p.name}</strong>
                {p.description && <div className="muted small">{p.description}</div>}
                <details>
                  <summary className="tiny">{t("tests.stepCount", { count: p.definition.root.slots?.body?.length ?? 0 })}</summary>
                  <ol className="tiny">
                    {labels(p.definition.root.slots?.body ?? []).map((l, j) => (
                      <li key={j}>{l}</li>
                    ))}
                  </ol>
                </details>
              </div>
            </label>
          ))}
        </div>
        <Field label={t("genTests.folder")}>
          <select value={folderId} onChange={(e) => setFolderId(e.target.value)}>
            <option value="">{t("genTests.topLevel")}</option>
            {folders.map((f) => (
              <option key={f.id} value={f.id}>
                📁 {pathOf(f.id)}
              </option>
            ))}
          </select>
        </Field>
        <label className="check-row">
          <input type="checkbox" checked={runNow} onChange={(e) => setRunNow(e.target.checked)} />
          {t("genTests.runNow")}
        </label>
      </>
    );
  } else if (explore?.status === "done" && !writing) {
    // Explored, but AI could not write the tests (the error is above): write again, or explore again.
    body = <p className="muted small">{t("genTests.writeFailed", { count: pagesFound })}</p>;
  } else if (explore && explore.status !== "failed" && explore.status !== "cancelled") {
    const line = writing
      ? t("genTests.writing", { count: pagesFound })
      : explore.status === "pending"
        ? t("genTests.starting", { pc: pc?.name ?? "" })
        : explore.stage === "prefix"
          ? t("genTests.signingIn")
          : explore.stage === "waiting"
            ? t("genTests.waiting", { pc: pc?.name ?? "" })
            : explore.stage === "exploring"
              ? t("genTests.exploring", { page: explore.note ?? "…" })
              : t("genTests.starting", { pc: pc?.name ?? "" });
    body = (
      <div className="gen-progress">
        <div className="spinner" aria-hidden />
        <p>{line}</p>
        {explore.stage === "waiting" && !writing && <p className="notice small">{t("genTests.waitingHelp")}</p>}
        {writing && <p className="muted small">{t("genTests.writingHelp")}</p>}
        {/* The sign-in steps did not all run: exploring goes on from where they stopped. */}
        {explore.note && explore.stage !== "exploring" && !writing && <p className="warn-text small">{t("genTests.stepsFailed", { error: explore.note })}</p>}
      </div>
    );
  } else {
    body = (
      <>
        <p className="muted small">{t("genTests.intro")}</p>
        <Field label={t("genTests.url")}>
          <input value={url} placeholder="https://..." autoFocus onChange={(e) => setUrl(e.target.value)} />
        </Field>
        <Field label={t("genTests.signIn")}>
          <select value={signIn} onChange={(e) => setSignIn(e.target.value as SignIn)}>
            <option value="none">{t("genTests.signInNone")}</option>
            <option value="steps">{t("genTests.signInSteps")}</option>
            <option value="self">{t("genTests.signInSelf")}</option>
          </select>
        </Field>
        {signIn === "steps" && (
          <Field label={t("genTests.stepsFrom")} hint={t("genTests.stepsFromHint")}>
            <select value={stepsFrom} onChange={(e) => setStepsFrom(e.target.value)}>
              <option value="">{t("genTests.chooseSteps")}</option>
              <optgroup label={t("tests.title")}>
                {cases
                  .filter((c) => !c.workflowId)
                  .map((c) => (
                    <option key={c.id} value={`tc:${c.id}`}>
                      🧪 {c.name}
                    </option>
                  ))}
              </optgroup>
              <optgroup label={t("genTests.workflows")}>
                {workflows.map((w) => (
                  <option key={w.id} value={`wf:${w.id}`}>
                    {w.name}
                  </option>
                ))}
              </optgroup>
            </select>
          </Field>
        )}
        {signIn === "self" && (
          <Field label={t("genTests.asset")} hint={t("genTests.assetHint")}>
            <select value={asset} onChange={(e) => setAsset(e.target.value)}>
              <option value="">{t("genTests.noAsset")}</option>
              {assets.map((a) => (
                <option key={a.name} value={a.name}>
                  🔑 {a.name}
                </option>
              ))}
            </select>
          </Field>
        )}
        <Field label={t("genTests.focus")} hint={t("genTests.focusHint")}>
          <textarea rows={2} value={focus} placeholder={t("genTests.focusPlaceholder")} onChange={(e) => setFocus(e.target.value)} />
        </Field>
        <div className="gen-row">
          <Field label={t("genTests.count")}>
            <select value={count} onChange={(e) => setCount(Number(e.target.value))}>
              {[3, 5, 8, 12].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t("genTests.pages")}>
            <select value={maxPages} onChange={(e) => setMaxPages(Number(e.target.value))}>
              {[3, 5, 8, 12].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t("genTests.pc")}>
            <select value={pcId} onChange={(e) => setPcId(e.target.value)}>
              {!pcs?.length && <option value="">{t("genTests.noPc")}</option>}
              {pcs?.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                  {p.canExplore ? "" : ` (${t("record.pcTooOld")})`}
                </option>
              ))}
            </select>
          </Field>
        </div>
        {pc && !pc.canExplore && <p className="warn-text small">{t("genTests.tooOld", { pc: pc.name, version: pc.version || "?" })}</p>}
        <p className="muted tiny">{t("genTests.safe")}</p>
      </>
    );
  }

  return (
    <Modal
      title={`✨ ${t("genTests.title")}`}
      onClose={() => void cancel()}
      footer={
        proposals ? (
          <>
            <button className="btn-ghost" onClick={() => void write(explore!.id)} disabled={writing || creating}>
              {writing ? t("genTests.writingShort") : t("genTests.again")}
            </button>
            <span className="spacer" />
            <button className="btn-ghost" onClick={onClose}>
              {t("common.cancel")}
            </button>
            <button className="btn" disabled={!chosen.size || creating} onClick={() => void create()}>
              {t("genTests.create", { count: chosen.size })}
            </button>
          </>
        ) : explore?.status === "done" && !writing ? (
          <>
            <button className="btn-ghost" onClick={() => setExplore(undefined)}>
              {t("genTests.exploreAgain")}
            </button>
            <span className="spacer" />
            <button className="btn" onClick={() => void write(explore.id)}>
              {t("genTests.again")}
            </button>
          </>
        ) : explore && explore.status !== "failed" && explore.status !== "cancelled" ? (
          <button className="btn-ghost" onClick={() => void cancel()}>
            {t("common.cancel")}
          </button>
        ) : (
          <>
            <button className="btn-ghost" onClick={onClose}>
              {t("common.cancel")}
            </button>
            <button className="btn" disabled={!canStart} onClick={() => void start()}>
              {t("genTests.start")}
            </button>
          </>
        )
      }
    >
      <ErrorBanner error={error} />
      {body}
    </Modal>
  );
}
