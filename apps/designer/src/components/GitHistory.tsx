import { useEffect, useState } from "react";
import type { Workflow } from "@zamtest/core";
import { useI18n } from "@zamtest/i18n/react";
import { api } from "../api";
import { ErrorBanner, Modal } from "./ui";

interface Commit {
  sha: string;
  message: string;
  author: string;
  date: string;
}

/** The workflow's commits in the workspace's Git repository; any of them can be opened in the editor. */
export function GitHistoryModal({ workflowId, onOpen, onClose }: { workflowId: string; onOpen: (definition: Workflow, sha: string) => void; onClose: () => void }) {
  const { t, dateTime } = useI18n();
  const [commits, setCommits] = useState<Commit[]>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    api<Commit[]>(`/api/workflows/${workflowId}/history`)
      .then(setCommits)
      .catch((e: Error) => setError(e.message));
  }, [workflowId]);

  const open = async (sha: string) => {
    try {
      const { definition } = await api<{ definition: Workflow }>(`/api/workflows/${workflowId}/history/${sha}`);
      onOpen(definition, sha);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <Modal title={t("git.historyTitle")} onClose={onClose}>
      <ErrorBanner error={error} />
      {commits && !commits.length && <p className="muted">{t("git.noHistory")}</p>}
      {commits && commits.length > 0 && (
        <ul className="git-history">
          {commits.map((c, i) => (
            <li key={c.sha}>
              <div>
                <strong>{c.message}</strong>
                <div className="muted tiny">
                  <code>{c.sha.slice(0, 7)}</code> · {c.author} · {dateTime(c.date)}
                </div>
              </div>
              {i > 0 && (
                <button className="btn-ghost" onClick={() => void open(c.sha)}>
                  {t("git.open")}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}
