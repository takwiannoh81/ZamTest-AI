import { useI18n } from "@zamtest/i18n/react";
import { HelpCenter } from "@zamtest/help";
import { api } from "../api";
import { PageHeader } from "../ui";

/** Docs (in the person's language) and the help assistant; #/docs/<section> opens a section. */
export function Docs({ section }: { section?: string }) {
  const { t } = useI18n();
  return (
    <>
      <PageHeader title={t("help.title")} subtitle={t("help.subtitle")} />
      <HelpCenter
        api={api}
        layout="page"
        where="the Portal"
        initial={section}
        onOpen={(id) => window.history.replaceState(null, "", `#/docs/${id}`)}
      />
    </>
  );
}
