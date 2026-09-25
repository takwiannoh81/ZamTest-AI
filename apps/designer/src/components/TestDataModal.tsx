import { useEffect, useRef, useState } from "react";
import { useI18n } from "@zamtest/i18n/react";
import { api } from "../api";
import { ErrorBanner, Modal } from "./ui";

export interface TestData {
  columns: string[];
  rows: string[][];
}

const MAX_ROWS = 1000;
const NAME = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** The file as base64, for the server to read (CSV or Excel). */
function readBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ""));
    reader.onerror = () => reject(reader.error ?? new Error("Could not read the file"));
    reader.readAsDataURL(file);
  });
}

/**
 * A test case's test data: a table whose columns are variables. The test runs
 * once per row; steps use a column as {{ username }}. Typed in, or imported
 * from a CSV or Excel file.
 */
export function TestDataModal({ testCaseId, onClose, onSaved }: { testCaseId: string; onClose: () => void; onSaved: () => void }) {
  const { t } = useI18n();
  const [data, setData] = useState<TestData>();
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [busy, setBusy] = useState(false);
  const file = useRef<HTMLInputElement>(null);

  useEffect(() => {
    api<{ data?: TestData }>(`/api/test-cases/${testCaseId}`)
      // New test data starts with the usual two columns.
      .then((c) => setData(c.data ?? { columns: ["username", "password"], rows: [["", ""]] }))
      .catch((e: Error) => setError(e.message));
  }, [testCaseId]);

  const update = (next: TestData) => {
    setData(next);
    setNotice(undefined);
  };
  const setCell = (r: number, c: number, value: string) => data && update({ ...data, rows: data.rows.map((row, i) => (i === r ? row.map((v, j) => (j === c ? value : v)) : row)) });
  const setColumn = (c: number, name: string) => data && update({ ...data, columns: data.columns.map((v, j) => (j === c ? name : v)) });
  const addColumn = () => data && update({ columns: [...data.columns, `column${data.columns.length + 1}`], rows: data.rows.map((r) => [...r, ""]) });
  const removeColumn = (c: number) => data && update({ columns: data.columns.filter((_, j) => j !== c), rows: data.rows.map((r) => r.filter((_, j) => j !== c)) });
  const addRow = () => data && data.rows.length < MAX_ROWS && update({ ...data, rows: [...data.rows, data.columns.map(() => "")] });
  const removeRow = (r: number) => data && update({ ...data, rows: data.rows.filter((_, i) => i !== r) });

  const importFile = async (f: File) => {
    setError(undefined);
    setBusy(true);
    try {
      const parsed = await api<TestData & { renamed: Array<{ from: string; to: string }>; truncated: boolean }>("/api/test-data/parse", {
        method: "POST",
        body: { fileName: f.name, base64: await readBase64(f) },
      });
      setData({ columns: parsed.columns, rows: parsed.rows });
      const notes = [t("testData.imported", { rows: parsed.rows.length, name: f.name })];
      if (parsed.renamed.length) notes.push(t("testData.renamed", { list: parsed.renamed.map((r) => `${r.from} → ${r.to}`).join(", ") }));
      if (parsed.truncated) notes.push(t("testData.truncated", { max: MAX_ROWS }));
      setNotice(notes.join(" "));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
      if (file.current) file.current.value = "";
    }
  };

  const bad = data?.columns.find((c) => !NAME.test(c));
  const duplicate = data?.columns.find((c, i) => data.columns.indexOf(c) !== i);
  const problem = bad !== undefined ? t("testData.badName", { name: bad || "…" }) : duplicate ? t("testData.duplicate", { name: duplicate }) : undefined;

  const save = async (clear = false) => {
    if (!data) return;
    setError(undefined);
    try {
      await api(`/api/test-cases/${testCaseId}`, { method: "PUT", body: { data: clear || !data.columns.length ? null : data } });
      onSaved();
      onClose();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <Modal
      title={t("testData.title")}
      onClose={onClose}
      footer={
        <>
          <button className="btn-ghost danger" onClick={() => confirm(t("testData.confirmClear")) && void save(true)}>
            {t("testData.clear")}
          </button>
          <span className="spacer" />
          <button className="btn-ghost" onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button className="btn" disabled={!data || Boolean(problem)} onClick={() => void save()}>
            {t("common.save")}
          </button>
        </>
      }
    >
      <p className="muted small">{t("testData.help")}</p>
      <div className="test-data-tools">
        <input ref={file} type="file" accept=".csv,.xlsx,.txt,.tsv" hidden onChange={(e) => e.target.files?.[0] && void importFile(e.target.files[0])} />
        <button className="btn-ghost" disabled={busy} onClick={() => file.current?.click()}>
          ⤒ {busy ? t("testData.importing") : t("testData.import")}
        </button>
        <button className="btn-ghost" onClick={addColumn}>
          + {t("testData.addColumn")}
        </button>
        <button className="btn-ghost" disabled={!data || data.rows.length >= MAX_ROWS} onClick={addRow}>
          + {t("testData.addRow")}
        </button>
        {data && <span className="muted small">{t("testData.size", { rows: data.rows.length, columns: data.columns.length })}</span>}
      </div>
      <ErrorBanner error={error ?? problem} />
      {notice && <p className="notice small">{notice}</p>}
      {data && (
        <div className="test-data-grid">
          <table>
            <thead>
              <tr>
                <th className="row-no">#</th>
                {data.columns.map((c, j) => (
                  <th key={j}>
                    <div className="col-head">
                      <input value={c} className={NAME.test(c) ? "" : "invalid"} aria-label={t("testData.columnName")} onChange={(e) => setColumn(j, e.target.value.trim())} />
                      <button className="icon-btn" title={t("testData.removeColumn")} aria-label={t("testData.removeColumn")} onClick={() => removeColumn(j)}>
                        ×
                      </button>
                    </div>
                    <code className="tiny muted">{`{{ ${c} }}`}</code>
                  </th>
                ))}
                <th />
              </tr>
            </thead>
            <tbody>
              {data.rows.map((row, i) => (
                <tr key={i}>
                  <td className="row-no muted">{i + 1}</td>
                  {row.map((v, j) => (
                    <td key={j}>
                      <input value={v} onChange={(e) => setCell(i, j, e.target.value)} />
                    </td>
                  ))}
                  <td>
                    <button className="icon-btn" title={t("testData.removeRow")} aria-label={t("testData.removeRow")} onClick={() => removeRow(i)}>
                      ×
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="muted tiny">{t("testData.secrets")}</p>
    </Modal>
  );
}
