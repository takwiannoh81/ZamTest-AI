/**
 * Templates: ready-made workflows and test cases to start from, shown in the
 * Designer's template gallery. Their names, descriptions and set-up notes are
 * translated (templates.<id>.name / .description / .setup in @zamtest/i18n);
 * the steps' labels are in English. Addresses, paths, mail servers and asset
 * names are examples to replace: the set-up note (put in the new workflow's
 * description) says what to change.
 */
import type { Step, VariableDef, Workflow } from "./schema.js";

export type TemplateCategory = "email" | "data" | "web" | "integration" | "testing";

export interface Template {
  id: string;
  icon: string;
  category: TemplateCategory;
  /** A workflow, or a test case (Test cases tab). */
  kind: "workflow" | "test";
  /** What starts it best: shown as a hint on the card. */
  startsWith?: "email" | "webhook" | "file" | "schedule";
  /** Uses AI actions (needs the AI to be set up). */
  ai?: boolean;
  variables: VariableDef[];
  steps: Step[];
}

let n = 0;
/** A step; ids are given in order (templates get fresh ids when they are used). */
const s = (type: string, label: string, props: Record<string, unknown>, slots?: Record<string, Step[]>): Step => ({
  id: `t${++n}`,
  type,
  label,
  props,
  ...(slots ? { slots } : {}),
});
const v = (name: string, type: VariableDef["type"], direction: VariableDef["direction"] = "local", extra: Partial<VariableDef> = {}): VariableDef => ({
  name,
  type,
  direction,
  ...extra,
});

export const TEMPLATES: Template[] = [
  {
    id: "invoice-email-to-excel",
    icon: "🧾",
    category: "email",
    kind: "workflow",
    startsWith: "email",
    ai: true,
    variables: [
      v("trigger", "object", "in", { description: "The email, from an email trigger" }),
      v("mails", "array"),
      v("attachment", "object"),
      v("invoice", "object"),
      v("saved", "number", "out", { default: 0 }),
    ],
    steps: [
      s("email.read", "Read the email and save its attachments", {
        server: "outlook.office365.com:993",
        credential: "Mail/Invoices",
        messageId: "{{ trigger.messageId }}",
        attachmentsFolder: "C:\\ZamTech\\Invoices",
        output: "mails",
      }),
      s("core.forEach", "For each attachment", { items: "mails.length ? mails[0].attachments : []", itemVariable: "attachment" }, {
        body: [
          s("core.if", "Only PDFs and scans", { condition: '/\\.(pdf|png|jpe?g)$/i.test(attachment.filename) && Boolean(attachment.path)' }, {
            then: [
              // Read on the server; a person checks it in the Portal (Reviews) when AI is unsure of a field.
              s("doc.process", "Read the invoice (a person checks it when AI is unsure)", {
                path: "{{ attachment.path }}",
                documentType: "invoice",
                review: "when unsure",
                title: "Invoice from {{ trigger.from }}",
                waitMinutes: 240,
                output: "invoice",
              }),
              s("core.if", "Unless the reviewer rejected it", { condition: 'invoice.status !== "rejected"' }, {
                then: [
                  s("excel.write", "Add a row to the invoice register", {
                    path: "C:\\ZamTech\\invoices.xlsx",
                    sheet: "Invoices",
                    rows: "[{ ...invoice.fields, checkedBy: invoice.reviewedBy ?? 'AI', file: attachment.filename, from: trigger.from }]",
                    append: true,
                  }),
                  s("core.assign", "Count it", { variable: "saved", value: "saved + 1" }),
                ],
                else: [s("core.log", "Note the rejection", { message: "{{ attachment.filename }} was rejected: {{ invoice.comment }}", level: "warn" })],
              }),
            ],
            else: [],
          }),
        ],
      }),
      s("core.log", "Done", { message: "Saved {{ saved }} invoice(s) from \"{{ trigger.subject }}\"" }),
    ],
  },
  {
    id: "email-digest",
    icon: "📬",
    category: "email",
    kind: "workflow",
    startsWith: "schedule",
    ai: true,
    variables: [v("mails", "array"), v("summary", "string"), v("sendTo", "string", "in", { default: "me@example.com" })],
    steps: [
      s("email.read", "Read the unread emails", { server: "outlook.office365.com:993", credential: "Mail/Inbox", unreadOnly: true, limit: 30, output: "mails" }),
      s("core.if", "Only when there are new emails", { condition: "mails.length > 0" }, {
        then: [
          s("ai.prompt", "Summarize them", {
            system: "You write short, clear email digests for a busy person.",
            prompt:
              "Summarize these emails in a few bullet points: who wants what, and anything urgent first.\n\n{{ mails.map(m => `From: ${m.from}\\nSubject: ${m.subject}\\n${m.text.slice(0, 1500)}`).join('\\n\\n---\\n\\n') }}",
            output: "summary",
          }),
          s("email.send", "Send the digest", {
            server: "smtp.office365.com:587",
            credential: "Mail/Inbox",
            to: "{{ sendTo }}",
            subject: "Your email digest: {{ mails.length }} new",
            body: "{{ summary }}",
          }),
        ],
        else: [s("core.log", "Nothing new", { message: "No unread emails" })],
      }),
    ],
  },
  {
    id: "excel-to-web-form",
    icon: "⌨",
    category: "data",
    kind: "workflow",
    variables: [
      v("file", "string", "in", { default: "C:\\ZamTech\\customers.xlsx" }),
      v("rows", "array"),
      v("row", "object"),
      v("error", "object"),
      v("done", "number", "out", { default: 0 }),
      v("failed", "array", "out", { default: [] }),
    ],
    steps: [
      s("excel.read", "Read the rows", { path: "{{ file }}", hasHeader: true, output: "rows" }),
      s("browser.open", "Open the website", { url: "https://example.com/customers/new" }),
      s("core.forEach", "For each row", { items: "rows", itemVariable: "row" }, {
        body: [
          s("core.tryCatch", "Enter one row", { errorVariable: "error" }, {
            try: [
              s("browser.navigate", "Open an empty form", { url: "https://example.com/customers/new" }),
              s("browser.type", "Type the name", { selector: "#name", text: "{{ row.Name }}", description: "The Name field" }),
              s("browser.type", "Type the email", { selector: "#email", text: "{{ row.Email }}", description: "The Email field" }),
              s("browser.type", "Type the phone", { selector: "#phone", text: "{{ row.Phone }}", description: "The Phone field" }),
              s("browser.click", "Save", { selector: "button[type=submit]", description: "The Save button of the form" }),
              s("browser.waitFor", "Wait until it is saved", { selector: "text=Saved", timeoutMs: 15000, description: "The message that says it was saved" }),
              s("core.assign", "Count it", { variable: "done", value: "done + 1" }),
            ],
            catch: [
              s("core.log", "Note the row that failed", { message: "Row {{ row.Name }} failed: {{ error.message }}", level: "warn" }),
              s("core.assign", "Remember it", { variable: "failed", value: "[...failed, row.Name]" }),
            ],
            finally: [],
          }),
        ],
      }),
      s("browser.close", "Close the browser", {}),
      s("core.log", "Done", { message: "Entered {{ done }} of {{ rows.length }} rows" }),
    ],
  },
  {
    id: "web-table-to-excel",
    icon: "📊",
    category: "web",
    kind: "workflow",
    startsWith: "schedule",
    ai: true,
    variables: [v("pageText", "string"), v("result", "object"), v("rows", "array", "out")],
    steps: [
      s("browser.open", "Open the page", { url: "https://example.com/prices" }),
      s("browser.waitFor", "Wait for the list", { selector: "table", description: "The table with the data", timeoutMs: 30000 }),
      s("browser.getText", "Read the list", { selector: "table", description: "The table with the data", output: "pageText" }),
      s("ai.extract", "Turn it into rows", {
        input: "{{ pageText }}",
        instructions: "Every row of the table. Prices as numbers, without the currency sign.",
        schema: {
          type: "object",
          properties: {
            rows: {
              type: "array",
              items: {
                type: "object",
                properties: { name: { type: "string" }, price: { type: "number" }, available: { type: "boolean" } },
                required: ["name", "price", "available"],
                additionalProperties: false,
              },
            },
          },
          required: ["rows"],
          additionalProperties: false,
        },
        output: "result",
      }),
      s("core.assign", "Keep the rows", { variable: "rows", value: "result.rows" }),
      s("excel.write", "Save them in Excel", { path: "C:\\ZamTech\\prices.xlsx", sheet: "{{ new Date().toISOString().slice(0, 10) }}", rows: "rows" }),
      s("browser.close", "Close the browser", {}),
    ],
  },
  {
    id: "webhook-to-api",
    icon: "🔗",
    category: "integration",
    kind: "workflow",
    startsWith: "webhook",
    variables: [
      v("trigger", "object", "in", { description: "The web request, from a web request trigger" }),
      v("token", "string"),
      v("response", "object"),
      v("createdId", "string", "out"),
    ],
    steps: [
      s("core.if", "Check the request", { condition: "!trigger.body || !trigger.body.email" }, {
        then: [s("core.throw", "Refuse a request without an email", { message: "The request has no email: {{ JSON.stringify(trigger.body) }}" })],
        else: [],
      }),
      s("core.getAsset", "Read the API key", { name: "CRM/ApiKey", output: "token" }),
      s("data.httpRequest", "Create the contact", {
        method: "POST",
        url: "https://api.example-crm.com/v1/contacts",
        headers: { Authorization: "Bearer {{ token }}", "Content-Type": "application/json" },
        body: { name: "{{ trigger.body.name }}", email: "{{ trigger.body.email }}", source: "ZamTech AI" },
        output: "response",
      }),
      s("core.if", "Did it work?", { condition: "response.status >= 300" }, {
        then: [s("core.throw", "Stop with the API's answer", { message: "The CRM answered {{ response.status }}: {{ JSON.stringify(response.body) }}" })],
        else: [
          s("core.assign", "Keep the new id", { variable: "createdId", value: "String(response.body.id ?? '')" }),
          s("core.log", "Done", { message: "Created contact {{ createdId }} for {{ trigger.body.email }}" }),
        ],
      }),
    ],
  },
  {
    id: "queue-dispatcher-performer",
    icon: "☷",
    category: "data",
    kind: "workflow",
    startsWith: "schedule",
    variables: [
      v("file", "string", "in", { default: "C:\\ZamTech\\invoices.xlsx" }),
      v("rows", "array"),
      v("row", "object"),
      v("item", "object"),
      v("error", "object"),
      v("processed", "number", "out", { default: 0 }),
    ],
    steps: [
      s("excel.read", "Read the invoices", { path: "{{ file }}", output: "rows" }),
      s("core.forEach", "Queue one item per invoice", { items: "rows", itemVariable: "row" }, {
        body: [s("queue.add", "Add it to the queue", { queue: "Invoices", data: { number: "{{ row.number }}", total: "{{ row.total }}" }, reference: "{{ row.number }}" })],
      }),
      s("queue.getNext", "Take the first item", { queue: "Invoices", output: "item" }),
      s("core.while", "Until the queue is empty", { condition: "item", maxIterations: 10000 }, {
        body: [
          s("core.tryCatch", "Process one item", { errorVariable: "error" }, {
            try: [
              s("core.if", "Reject invoices without a total", { condition: "!Number(item.data.total)" }, {
                then: [s("queue.complete", "Business exception", { item: "item", status: "business-exception", message: "The invoice has no total" })],
                else: [
                  s("core.log", "Do the work here", { message: "Processing invoice {{ item.data.number }} ({{ item.data.total }})" }),
                  s("queue.complete", "Done", { item: "item", status: "successful" }),
                  s("core.assign", "Count it", { variable: "processed", value: "processed + 1" }),
                ],
              }),
            ],
            catch: [s("queue.complete", "Failed: it is tried again later", { item: "item", status: "failed", message: "{{ error.message }}" })],
            finally: [],
          }),
          s("queue.getNext", "Take the next item", { queue: "Invoices", output: "item" }),
        ],
      }),
    ],
  },
  {
    id: "document-register",
    icon: "🗂",
    category: "data",
    kind: "workflow",
    startsWith: "file",
    ai: true,
    variables: [v("trigger", "object", "in", { description: "The file, from a file trigger" }), v("info", "object")],
    steps: [
      s("doc.process", "Find out what it is", {
        path: "{{ trigger.path }}",
        documentType: "custom",
        fields: "kind - invoice, contract, order, letter or other\nfrom - who sent or wrote it\ndate:date - the date on the document\nsubject - what it is about, in a few words",
        review: "never",
        output: "info",
      }),
      s("csv.write", "Add it to the register", {
        path: "C:\\ZamTech\\document-register.csv",
        rows: "[{ file: trigger.name, kind: info.fields.kind, from: info.fields.from, date: info.fields.date, subject: info.fields.subject, summary: info.summary, added: new Date().toISOString() }]",
        append: true,
      }),
      s("core.log", "Done", { message: "{{ trigger.name }}: {{ info.fields.kind }} from {{ info.fields.from }}" }),
    ],
  },
  {
    id: "page-watcher",
    icon: "👁",
    category: "web",
    kind: "workflow",
    startsWith: "schedule",
    variables: [v("text", "string"), v("lookFor", "string", "in", { default: "In stock" }), v("sendTo", "string", "in", { default: "me@example.com" })],
    steps: [
      s("browser.open", "Open the page", { url: "https://example.com/product/123" }),
      s("browser.getText", "Read the part to watch", { selector: "#availability", description: "The text that shows whether it is available", output: "text" }),
      s("browser.close", "Close the browser", {}),
      s("core.if", "Is it there?", { condition: "text.toLowerCase().includes(lookFor.toLowerCase())" }, {
        then: [
          s("email.send", "Send an alert", {
            server: "smtp.office365.com:587",
            credential: "Mail/Alerts",
            to: "{{ sendTo }}",
            subject: "\"{{ lookFor }}\" is on the page now",
            body: "The page https://example.com/product/123 now says: {{ text }}",
          }),
        ],
        else: [s("core.log", "Not yet", { message: "The page says: {{ text }}" })],
      }),
    ],
  },
  {
    id: "website-smoke-test",
    icon: "🧪",
    category: "testing",
    kind: "test",
    startsWith: "schedule",
    variables: [],
    steps: [
      s("browser.open", "Open the home page", { url: "https://example.com" }),
      s("browser.verifyTitle", "The title is right", { text: "Example", match: "contains" }),
      s("browser.verifyVisible", "The main menu shows", { selector: "nav, header" }),
      s("browser.click", "Open a main page", { selector: "text=About", description: "A link in the main menu" }),
      s("browser.verifyUrl", "It opened", { text: "/about", match: "contains" }),
      s("browser.close", "Close the browser", {}),
    ],
  },
  {
    id: "login-test",
    icon: "🔐",
    category: "testing",
    kind: "test",
    startsWith: "schedule",
    variables: [v("signIn", "object", "local", { description: "The saved sign-in (user name and password)" })],
    steps: [
      s("core.getAsset", "Read the sign-in", { name: "Login/example.com", output: "signIn" }),
      s("browser.open", "Open the sign-in page", { url: "https://example.com/login" }),
      s("browser.type", "Type the user name", { selector: "#username", text: "{{ signIn.username }}", description: "The user name or email field" }),
      s("browser.type", "Type the password", { selector: "#password", text: "{{ signIn.password }}", description: "The password field" }),
      s("browser.click", "Sign in", { selector: "button[type=submit]", description: "The sign-in button" }),
      s("browser.verifyVisible", "The sign-in form is gone", { selector: "#password", visible: false, timeoutMs: 20000 }),
      s("browser.verifyText", "The account page shows", { selector: "body", text: "Sign out", match: "contains" }),
      s("browser.close", "Close the browser", {}),
    ],
  },
];

/** A template as a new workflow: the given (translated) name, and its set-up note as description. */
export function workflowFromTemplate(template: Template, name: string, description?: string): Workflow {
  return {
    schemaVersion: 1,
    id: template.id,
    name,
    description,
    variables: structuredClone(template.variables),
    root: { id: "root", type: "core.sequence", props: {}, slots: { body: structuredClone(template.steps) } },
  };
}
