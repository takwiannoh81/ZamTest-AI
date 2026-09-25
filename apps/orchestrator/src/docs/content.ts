/**
 * The platform's documentation (English), shown in Docs in the Portal and the Designer,
 * translated on first view into the reader's language, and used by the help assistant.
 * Each section is Markdown: ## and ### headings, paragraphs, - lists, 1. lists, **bold**, `code`, and [links](https://...).
 */
export interface DocSection {
  id: string; // kebab-case, stable
  title: string;
  /** Short line under the title in the list. */
  summary: string;
  body: string; // Markdown, no top-level # heading (the title is shown separately)
}

export const DOCS: DocSection[] = [
  /* ------------------------------------------------------------------ */
  {
    id: "getting-started",
    title: "Getting started",
    summary: "What ZamTech AI is, and your first automation in a few steps",
    body: `ZamTech AI is a low-code platform for automating business processes and testing applications. You build automations visually, run them on your own Windows PCs, and manage everything from one place. AI helps at every step: it can draft workflows, fix failed runs and repair broken selectors.

## The three parts

- **Portal** ([portal.zamtechai.com](https://portal.zamtechai.com)). This is where you run and manage your work: start processes, watch jobs and their logs, set up schedules and queues, store assets (such as passwords), connect bot PCs and manage users.
- **Designer** ([designer.zamtechai.com](https://designer.zamtechai.com)). This is where you build workflows and test cases: record, drag actions onto a canvas, or describe what you want and let AI build it.
- **Bot agent**. The **ZamTech AI Agent** is a small program you install on each Windows PC that should do the work. It clicks, types and reads screens, websites and files for you. It only needs an outgoing internet connection. Developers can also run the agent on Linux for web automations (see **Install the agent**).

## Your first automation

1. **Create an account.** On the Portal's sign-in page, choose **Create an account**. Enter your company, your name, your email and a password (at least 10 characters). The Free plan needs no card.
2. **Confirm your email.** Open the link we send you. If it does not arrive, use **Send the link again** and check your spam folder.
3. **Install the agent.** In the Portal, open **Bot Agents** and click **⬇ Download for Windows**. Run the installer and approve the PC in the Portal. The Designer opens next.
4. **Build a workflow.** In the Designer, click **+ New workflow**. Click **● Record** to record what you do in a website or Windows program, or drag actions from the palette on the left.
5. **Try it.** Click **Save**, then **▶ Run**. The Run panel shows each step as it happens on your PC.
6. **Publish it.** Click **Publish**. The workflow becomes a process in the Portal.
7. **Run it for real.** In the Portal, open **Processes** and click **▶ Start**, or create a schedule under **Schedules**.

## Signing in

You sign in on the Portal with your email and password. The Designer uses the same sign-in: if you are not signed in, it sends you to the Portal and brings you back afterwards.

**One sign-in per account.** Your account can be signed in on one browser or PC at a time. When you sign in somewhere else, the other browser is signed out and shows: "You were signed out because your account signed in on another browser or PC." Each person should have their own account.

Forgot your password? Click **Forgot password?** on the sign-in page and we email you a link to choose a new one.

## Language and colours

The Portal and Designer are available in 14 languages: English, Japanese, Simplified Chinese, French, Spanish, Brazilian Portuguese, German, Dutch, Russian, Vietnamese, Thai, Afrikaans, Swahili and Arabic (right to left). Pick yours in the language list in the Portal's menu, in the Designer's toolbar, or under **Settings**. AI answers in your language too.

Under **Colours** you can choose **Light**, **Dark** or **Automatic**. Automatic follows your device's light or dark setting. Your choice is kept on this browser for the website, the Portal and the Designer.`,
  },

  /* ------------------------------------------------------------------ */
  {
    id: "install-agent",
    title: "Install the agent",
    summary: "Put the ZamTech AI Agent on a Windows PC, approve it, and keep it up to date",
    body: `The **ZamTech AI Agent** runs your automations. Install it on each Windows PC that should run jobs, record steps or indicate elements. It needs Windows 10 or newer (64-bit). It installs for your Windows user only, so you do not need administrator rights. It runs in your signed-in Windows session, because desktop automation needs a real screen.

## Install and approve a PC

1. In the Portal, open **Bot Agents** and click **⬇ Download for Windows**.
2. Run the installer. You can choose:
   - **Start the agent when I sign in to Windows** (on by default).
   - **Download Chromium for web automation (about 150 MB)** (off by default).
3. Click **Finish**. Your browser opens the Portal's **Connect this PC** page.
4. **Sign in again.** For safety, the page signs out whoever was signed in on that browser, so the right person approves the PC.
5. Check the **Code**. The ZamTech AI icon in the system tray shows a code such as \`KDTR-7QMX\`. The Portal must show the same code.
6. Click **Approve this PC**. Only a Developer or Admin can approve. Anyone else sees a message to send the link to one of them.
7. The Portal says "This PC is connected and can now run automations." Then the Designer opens.

Only approve a PC you are setting up yourself: an approved PC can use your workspace's stored credentials. If you wait too long, the code expires (after 15 minutes). Start the agent again for a new one.

## The tray icon

The agent lives in the Windows system tray. Right-click its icon to see its status (for example **Connected** or **Running a job**) and to use **Open Designer**, **Open Portal**, **Settings...** (server address, bot name, **Test connection**, **Connect this PC again**), **Open log**, **Run desktop self-test**, **Record a desktop workflow...**, **Restart agent** and **Quit**.

The Start menu has a **ZamTech AI Agent** folder with the agent, its settings, the Designer, **Desktop self-test** and **Agent logs**.

## Install keys for IT (silent installs)

To install on many PCs without approving each one, an Admin creates an install key. Install keys are part of the Enterprise plan.

1. In the Portal, open **Bot Agents** and scroll to **Install keys**.
2. Enter a name, **Max. PCs** and **Expires after (days)**, then click **Create**.
3. Copy the key now: it is shown only once. The page also shows the **Silent install command**.

The command looks like this:

\`ZamTechAI-Agent-Setup.exe /VERYSILENT /INSTALLKEY=<install key> /NAME=finance-pc-01\`

\`/NAME\` (the bot name) is optional. Other options: \`/MERGETASKS="browsers"\` also downloads Chromium, \`/MERGETASKS="!autostart"\` does not start the agent at Windows sign-in, \`/NOSTART\` leaves it stopped after setup, and \`/CANCELJOB\` cancels a running job during an upgrade instead of waiting.

Anyone with a key can connect PCs, so keep it secret and give it a limit. Deleting a key does not disconnect PCs that already use it.

## Upgrading

Download the latest installer from the Portal and run it over the old one. Your connection and settings are kept. If the agent is running a job, the upgrade waits for it to finish (up to 10 minutes).

**When the Designer says "update the agent"**, that PC's agent is too old for a feature such as recording, Indicate or AI looking at an application. Click **⬇ Download for Windows** in the Portal, install it over the old one, and make sure the agent is running.

## Reinstalling

If you uninstall and install again, or set up Windows again, approve the PC again. The Portal says "This PC was connected before as ..." and approving brings back the same bot, with its name, environment and history, instead of adding a new one.

## Offline bots

On **Bot Agents**, each PC shows **online**, **busy** or **offline**. An offline PC cannot run jobs. Start the ZamTech AI Agent on it (it is in the system tray). If the PC was reinstalled, approve it again.

## Linux (for developers)

On Linux, for example a cloud server, the agent runs web automations only (headless when there is no screen). There is no installer. Open **Bot Agents**, expand **Linux (web automations, for developers)** and follow the commands shown there. They need Node.js 20 or newer and pnpm.`,
  },

  /* ------------------------------------------------------------------ */
  {
    id: "designer-basics",
    title: "Designer basics",
    summary: "The canvas, the palette, the Properties panel, saving and running",
    body: `The Designer is where you build workflows and test cases. A workflow is a list of steps that run from **Start** to **End**. Some steps, such as **If** or **For Each**, hold other steps inside them.

## The start screen

- **+ New workflow** creates an empty workflow and opens it.
- **Import from PC** opens a workflow file, or a whole project file, from your computer.
- **Export project** saves all workflows, test folders and test cases in one file on your PC.
- **Open Portal ↗** opens the Portal.
- The **Workflows** and **Test cases** tabs list your work. Click a card to open it, or 🗑 to delete it.

## The editor

The editor has three areas:

- **Palette** (left). All actions, grouped by category, such as Browser, Desktop, Excel & CSV, Email, AI and Verify. Type in **Search actions...** to filter. Drag an action onto the canvas, double-click it, or click its **+** to add it after the selected step.
- **Canvas** (middle). Your steps. Drag a step to move it. Each step has buttons to **Duplicate** (⧉) or **Delete** (🗑) it. Steps that point at screen elements also have ◎ (**Indicate on screen**). Containers can be collapsed and expanded.
- **Properties panel** (right). The settings of the selected step. When no step is selected, it shows the workflow's name, description and **Variables & arguments**.

### Adding a step between steps

Hover between two steps and click **+** (**Add a step here**). A list of actions opens with a search box. Type a few letters, use the arrow keys, and press Enter to add the highlighted action. Press Esc to close the list.

## Step settings

- **Label** gives the step a short name that shows on the canvas.
- Fields marked with \`*\` are required.
- **Disabled (skip at run time)** keeps the step but skips it when the workflow runs.
- **Error handling & timeouts** (for most steps):
  - **Continue on error**: if the step fails, the workflow carries on.
  - **Retry count** (up to 20) and **Retry delay (ms)**: try a failed step again.
  - **Timeout (ms)**: stop the step if it takes longer.

Steps with retries or continue on error show a tag such as \`retry×2\` on the canvas.

## The toolbar

- **←** goes back to all workflows. A dot (●) means there are unsaved changes.
- **↶ Undo** (Ctrl+Z) and **↷ Redo** (Ctrl+Shift+Z or Ctrl+Y).
- **✓ Valid** or **⚠ N issues**. Click it to see the problems. Click a problem to jump to the step and the field to fill in, or use **✨ Fix with AI**.
- **{ } JSON** shows the workflow as JSON. You can copy it, or edit it and apply.
- **Save to PC** saves the workflow as a file on your computer.
- **● Record** records steps (see **Recording**).
- **✨ Build with AI** builds or changes the workflow from a description.
- **Save** (Ctrl+S) saves to ZamTech AI.
- **▶ Run** saves and runs the workflow on a PC.
- **Publish** releases a new version as a process in the Portal.
- 🗑 **Delete this workflow**. Published versions are kept.

With Git connected, **Commit** and **History** also appear (see **Environments, Git and CI/CD**).

Keyboard: Delete or Backspace removes the selected step when you are not typing in a field.

## Running and the Run panel

Click **▶ Run**. The Designer saves the workflow and sends it to an available PC. The **Test run** panel opens under the canvas:

- The status: queued, pending, running, succeeded, failed or cancelled.
- While the run waits, a message says why and what to do (see **Troubleshooting**).
- The log, line by line. Click a line to select its step. Failed steps are marked on the canvas.
- **Stop** ends the run.
- **✨ Self-healed** rows show selectors that AI repaired during the run. Click **Apply fix** to put the new selector in the step, then save.
- **Outputs:** the values of the workflow's out arguments.
- When a run fails, **✨ Fix with AI** finds the cause and suggests fixes.`,
  },

  /* ------------------------------------------------------------------ */
  {
    id: "recording",
    title: "Recording",
    summary: "Record clicks and typing in a website or Windows program",
    body: `The recorder watches what you do in a browser or a Windows program on your PC and turns it into steps. It is the fastest way to start a workflow.

## Before you start

The ZamTech AI Agent must be running on the PC you record on. If no PC is online, the Record window says **No PC is online**. Start the agent from the system tray, then open Record again.

## Record a website

1. In the Designer, select the step after which the new steps should go. With nothing selected, they go at the end.
2. Click **● Record** in the toolbar.
3. Choose **Website**.
4. In **Start at this address**, enter the page to start on, for example \`https://example.com\`.
5. In **Record on this PC**, choose the PC. The Designer remembers your choice.
6. Click **● Start recording**.
7. A browser opens on that PC. Click and type as usual.
8. Press **■ Stop** in the Designer, or close that browser.

## Record a Windows program

1. Click **● Record** and choose **Windows program**.
2. In **Program to start (optional)**, enter a program such as \`notepad.exe\`, or the full path of your application. Leave it empty to record whatever program you use.
3. Or click **◎ Indicate** and then click the application on your PC. This is easier than typing its path. The Designer shows "Selected: ..." and, because the program is open already, the recording starts in it. Press Esc on the PC to cancel.
4. Choose the PC and click **● Start recording**.
5. Work in the program as usual, then press **■ Stop** in the Designer.

## What you get

- Steps appear in the Record window live, as you click and type ("Steps appear here as you click and type").
- When you stop, the steps are added at the selected place: "Added N recorded steps. Review them, then save."
- A website recording starts with **Open Browser** at your address, followed by **Click**, **Type Into** and **Select Option** steps.
- A program recording starts with **Start Application** when you named a program, followed by desktop steps such as **Click (Desktop)** and **Type Into (Desktop)**.
- Each step gets a **Target description** (for example "the Login button"), which AI uses to repair the step if the screen changes later.

## Passwords are never stored

When you type into a password field, the recorder does not save what you typed. Instead, it adds an input argument named \`password\` (then \`password2\`, and so on) and the step types \`{{ password }}\`. Before you run the workflow for real, replace it with a credential asset (see **Assets**), or fill the input when you start the job.

## Tips

- Record short pieces and review them. It is easier to fix five steps than fifty.
- Log in and go to the right page before you record the part that matters, or record the login once and reuse it with **Call Workflow**.
- After recording, click **▶ Run** to check that it plays back.
- If a PC shows **(update the agent)** next to its name, its agent is too old to record. Install the latest agent from the Portal (**⬇ Download for Windows**).

## Recording from the tray

The agent's tray menu also has **Record a desktop workflow...**. It opens a console on the PC that records a Windows program and uploads the result to the Designer after you sign in. For most people, the **● Record** button in the Designer is simpler.`,
  },

  /* ------------------------------------------------------------------ */
  {
    id: "indicate-and-selectors",
    title: "Indicate and selectors",
    summary: "Point at screen elements, and how web and desktop selectors work",
    body: `Steps such as **Click** or **Type Into** need to know which element on the screen to use. That is the step's **selector**. You rarely need to write one: record the steps, or point at the element with **Indicate on screen**.

## Indicate on screen (◎)

Every step with a selector has a ◎ button, on the canvas and next to the selector field in the Properties panel.

### On a website

1. Click ◎ on the step. Choose the PC if asked.
2. A browser opens on that PC, at the page the workflow is on before this step (the last address opened before it).
3. Move the mouse: the element under it is outlined. Click the element you want. The page does not receive that click.
4. Need to log in or open a menu first? Press **F2** to use the page normally for 5 seconds.
5. Press **Esc** to cancel.

### In a Windows application

1. Open the application first.
2. Click ◎ on the step, then click the element in the application.
3. If the element is in a menu, press **F2**, open the menu within 5 seconds, then click the element.

The Designer fills in the selector and, if it is empty, the step's **Target description**. It shows "Element set: ...".

## Web selectors

Web steps use Playwright selectors. The most useful forms are:

- \`role=button[name="Sign in"]\`: an element by its role and accessible name. Good for buttons, links and fields.
- \`internal:label="Email"\`: a form field by its label.
- \`text="Continue"\`: an element by its visible text.
- \`css=#username\` or \`css=[data-testid="submit"]\`: a CSS selector.

The recorder prefers stable choices in this order: test ids (such as \`data-testid\`), a real element id, role and name, label, placeholder, the field's name, visible text, and finally a CSS path.

## Desktop selectors

Desktop steps find elements of Windows applications through Microsoft UI Automation. A desktop selector reads like a path:

- \`window[process="notepad"] > document\`
- \`window[name$=" - Notepad"] > menuitem[name="File"]\`
- \`window[name="Calculator"] > button[id="num7Button"]\`

The rules:
- Parts are separated by \`>\`. Each part is searched among everything inside the previous match. The first part is matched against top-level windows.
- Each part starts with a control type, such as \`window\`, \`button\`, \`edit\`, \`document\`, \`menuitem\`, \`listitem\`, \`combobox\`, \`checkbox\`, \`tab\`, \`treeitem\` or \`datagrid\`, or \`*\` for any.
- Attributes in brackets: \`name\`, \`id\` (the AutomationId), \`class\`, \`process\` (the first part only) and \`index\` (1-based, picks the n-th match, for example \`[index=2]\`).
- Operators: \`=\` exact, \`~=\` contains, \`^=\` starts with, \`$=\` ends with. Matching ignores upper and lower case.

**Start Application** has an optional **Wait for window** field: a window selector such as \`window[process="notepad"]\`.

## Target description and AI self-healing

Web and desktop steps that click, type or read have two extra fields:

- **Target description**: the element in plain words, such as "the blue Login button".
- **AI self-healing** (on by default): if the selector fails, AI looks for a replacement selector and tries once more.

When a selector is healed, the Run panel shows **✨ Self-healed** with **Apply fix**, and the Portal lists it on the job under **AI self-healed selectors**. Apply the fix in the Designer to make it permanent. The Designer warns you ("add a target description so AI can self-heal the selector") when a web step has no description.

Self-healing runs on the bot PC and needs AI to be set up for the agent. Ask your administrator if healing never happens.

## ✨ AI selector suggestions

For web steps, the **✨ AI** button next to the selector opens the **✨ AI selector assistant**:

1. In **Which element?**, describe it in plain language, such as "the Submit button under the shipping form".
2. In **Page HTML**, paste the page's HTML. In the browser, right-click the page, choose **Inspect**, right-click \`<html>\`, then **Copy > Copy outerHTML**.
3. Click **Suggest selectors**, then **Use** on the one you want.

Your description is saved as the step's target description.

## Dynamic targets: any item of a list

A step can work on **an item of a list chosen when it runs**, instead of one fixed element: for example, "choose the first option in a dropdown that is available" or "open the first order that is not closed". This keeps the step working when the list changes. It works on web pages and in Windows applications.

1. Click ◎ on the step and point at one item of the list (one row, one option).
2. The page outlines all similar items for a moment, and the Designer says "It is one of 17 similar items".
3. Choose **Any item like this one**. (Choose **Only this one** for a fixed element.)
4. In the step's properties, the **Item from a list** card sets the rules:
   - **Which one**: the first, the last, any one, or **the next one if it does not work** (tries the items in turn until the step works).
   - **Skip items that contain**: click ◎ and, in one item, point at what marks the items to skip, such as the offline icon. It shows how many items have it.
   - **Only items whose text contains** and **Skip items whose text contains**.
5. The step card then reads in plain words, such as "The first of 17 similar items, skipping the marked ones".

**Use one exact element instead** turns it back into a fixed element. Build with AI and Fix with AI can also make steps dynamic.`,
  },

  /* ------------------------------------------------------------------ */
  {
    id: "ai-features",
    title: "AI features",
    summary: "Build with AI, Fix with AI, AI actions, and what AI can see",
    body: `ZamTech AI uses Claude to help you build, fix and run automations. You always review AI's work before it is applied.

## ✨ Build with AI

Click **✨ Build with AI** in the Designer toolbar.

- **Start from scratch**: describe the process to automate. For example: "Open https://news.ycombinator.com, read the titles of the top 5 stories and have AI write a one-paragraph digest."
- **Modify current workflow**: say what should change. This option appears when the workflow already has steps.

Click **Generate**. AI shows the new workflow with a short explanation of its design. Click **Apply to canvas** to use it. Applying replaces the current canvas; you can undo with Ctrl+Z. Review it, then save.

AI knows the names of your assets (never their values), so it can use the right credential with **Get Asset**.

### Use an application on my PC (optional)

For a Windows application, open **Use an application on my PC (optional)** in the same window. Click **◎ Indicate**, then click the application on your PC. AI reads its real buttons and fields ("AI will use ... as it is on ... (N controls)") and builds the steps with real selectors. The application must be open on that PC.

## ✨ Generate tests with AI

In the **Test cases** tab, **✨ Generate tests with AI** writes a whole set of test cases for a website: a bot PC looks through the site's pages, and AI writes tests from what is really there. See **Test cases** for the steps.

## ✨ Fix with AI

There are two kinds:

- **Design issues.** When the toolbar shows **⚠ N issues**, click it, then **✨ Fix with AI**. AI proposes a corrected workflow for you to review.
- **A failed run.** When a run fails, click **✨ Fix with AI** in the Run panel.

For a failed run, AI finds the cause with evidence:
1. If the run used a Windows application, AI first looks at it on the PC ("Looking at the application on ...").
2. AI reads the run's log and step screenshots.
3. It shows a summary, the kind of cause (for example **Workflow**, **Screen element**, **Asset**, **Environment**, **Application**, **PC** or **Data**) and **How AI found this**.

Then it shows fix cards. Each card says what to do and why:
- **Step changes**: steps to add, remove or change. Click **Apply**.
- **Create asset**: a missing asset, with its name and type. Enter the value and click **Create**. The value is saved in ZamTech AI only; it is never sent to AI.
- **Set PC environment**: for example "Set PC-01 to Test". Click **Apply**.
- **Manual steps**: things only you can do, such as installing an application. Do them, then click **I did this**.

Click **Apply and run again** to try the fixed workflow. If it fails again, AI can find the next cause.

### Keep fixing until it passes

Choose **Keep fixing until it passes** and AI repeats the cycle on its own: fix, run, look again. It stops after 3 rounds, or when a fix needs you ("Some fixes need you (marked above). Do them, then press Continue."). When the run passes, review the changes and save.

## AI actions in workflows

The **AI** group in the palette has:
- **AI Prompt**: sends a prompt to Claude and saves the answer.
- **AI Extract Data**: pulls structured data (matching a JSON Schema) out of text such as an email or invoice.
- **AI Agent**: give it a **Goal** and it decides which actions to run (browser, HTTP, files) until the goal is met. **Allowed actions** limits what it may use, and **Max steps** (default 20) limits how long it runs.

These actions, and AI self-healing, run on the bot PC. They need AI to be set up for the agent on that PC; ask your administrator.

## What AI sees, and never sees

- AI sees the workflow, your descriptions, the run's log and step screenshots (for Fix with AI), and the application you indicate.
- AI sees asset **names and types** only. Asset values, such as passwords, are never sent to AI.
- Recorded passwords are never stored in the workflow.

## AI requests and your plan

Build with AI, Fix with AI and AI selector suggestions count as AI requests. The Free plan includes 20 a month; Pro includes 500 a month for each builder seat. See **Plans and billing**. When they are used up, the Designer shows a message with **View plans**.`,
  },

  /* ------------------------------------------------------------------ */
  {
    id: "variables-expressions",
    title: "Variables and expressions",
    summary: "Variables and arguments, expressions, {{ }} templates, and step results",
    body: `Variables hold values while a workflow runs: a customer name, a list of rows, a total. Arguments are variables that go in or out of the workflow.

## Variables & arguments

Click an empty part of the canvas so no step is selected. The Properties panel shows **Variables & arguments**. Click **+ Add** to add one. Each variable has:

- **Name**: letters, digits, \`_\` or \`$\`, not starting with a digit. For example \`invoiceTotal\`.
- **Type**: \`string\`, \`number\`, \`boolean\`, \`object\`, \`array\` or \`any\`.
- **Direction**:
  - \`local\`: used only inside the workflow.
  - \`in\`: an input, filled when a job starts (in the Start dialog, a schedule, a test case or **Call Workflow**).
  - \`out\`: an output, returned when the job ends. You see outputs in the Run panel and on the job in the Portal.
  - \`inout\`: both.
- **default (JSON)**: the starting value, written as JSON: \`0\`, \`"text"\`, \`true\`, \`[]\`.

The Designer warns you when a step uses a variable that is not declared, or when a name is declared twice.

## Expressions

Some fields are **expressions**, for example **Condition** in **If** or **Items** in **For Each**. An expression is a small JavaScript formula over your variables, written without braces:

- \`total > 100\`
- \`rows.length > 0\`
- \`status == "Paid" && amount > 0\`
- \`customer.name.toUpperCase()\`

## Templates in text

In ordinary text fields, put an expression inside \`{{ }}\` to insert its value:

- \`Hello {{ customer.name }}!\`
- \`https://example.com/orders/{{ order.id }}\`

If a field contains **only** one template, such as \`{{ items }}\`, the value keeps its type. A list stays a list instead of becoming text. This matters in JSON fields such as **Data** or **Inputs**, for example \`{"invoice": "{{ row.number }}"}\`.

## Assign

The **Assign** action (in **System**) sets a variable. **Variable** is the variable's name (no braces). **Value** is an expression, for example \`count + 1\` or \`"Done"\` (text in an expression needs quotes).

## Using a step's result

Many actions produce a result, such as the text they read or the rows of a file. Their last field says where to put it, for example:

- **Save result to** (most actions)
- **Save value to** (**Get Asset**)
- **Save item to** (**Get Next Queue Item**)
- **Save outputs to** (**Call Workflow**)
- **Save final answer to** (**AI Agent**)
- **Save text to** (**Read PDF Text**)

Enter a variable name there (no braces), and declare the variable. Later steps can use it, for example \`{{ pageTitle }}\` in text or \`rows.length\` in an expression.

## Loop and error variables

- **For Each** puts each item in its **Item variable** (default \`item\`) and, if you set one, its position in the **Index variable** (starting at 0).
- **Try / Catch** puts the error in its **Error variable** (default \`error\`). Use \`error.message\` in the catch steps.

You do not need to declare these three.

## Example

A workflow with an \`in\` argument \`customer\` (object) and an \`out\` argument \`greeting\` (string):

1. **Assign**: Variable \`greeting\`, Value \`"Hello " + customer.name\`.
2. **Log Message**: Message \`Greeting ready for {{ customer.name }}\`.

When you start it, fill \`customer\` with \`{"name": "Ada"}\`. The job's outputs show \`greeting: "Hello Ada"\`.`,
  },

  /* ------------------------------------------------------------------ */
  {
    id: "control-flow",
    title: "Control flow",
    summary: "Sequence, If, For Each, While, Try / Catch, Break, Throw and Call Workflow",
    body: `Control flow actions decide which steps run, how often, and what happens when something fails. They are in the **Control Flow** group of the palette. Containers show their inner areas on the canvas (such as **then** and **else**). Drop steps into them, or use the **+** inside them.

## Sequence

Runs the steps in its **body** in order. Use it to group steps, for example to collapse them on the canvas.

## If

Runs **then** when the **Condition** is true, otherwise **else**.

- Condition examples: \`total > 100\`, \`status == "Paid"\`, \`rows.length == 0\`.
- Leave **else** empty if nothing should happen.

## For Each

Runs its **body** once for each item in a list.

- **Items**: an expression that gives a list, for example \`rows\` or \`order.lines\`. If it is an object, each item is \`{ key, value }\`. If it is empty, the body does not run.
- **Item variable** (default \`item\`): the current item.
- **Index variable** (optional): the position, starting at 0.

Example: read a CSV into \`rows\`, then For Each over \`rows\` and type \`{{ item.email }}\` into a form.

## While

Repeats its **body** while the **Condition** is true.

- **Max iterations** (default 1000) protects you from endless loops. If the loop goes past it, the step fails with an error.
- Make sure something in the body changes the condition, for example with **Assign**.

## Break

Leaves the nearest **For Each** or **While** loop at once. Put it inside an **If**, for example "if the item is the one we want, Break".

## Try / Catch

Handles errors.

- **try**: the steps that might fail.
- **catch**: runs only when a step in try fails. The error is in the **Error variable** (default \`error\`), so you can log \`{{ error.message }}\`.
- **finally**: always runs at the end, whether try failed or not. Good for **Close Browser** or **Close Window**.

When catch handles the error, the workflow carries on after the Try / Catch.

Tip: for a single step, **Continue on error** and **Retry count** under **Error handling & timeouts** are often simpler than Try / Catch.

## Throw

Stops with an error and your **Message**, for example "Invoice {{ invoice.number }} has no total". A surrounding Try / Catch can catch it. Otherwise the job fails with that message.

## Call Workflow

Runs another of your workflows inside this one, as it is saved now. Use it to reuse parts, such as a login.

- **Workflow**: choose one from the list.
- **Inputs**: values for its \`in\` arguments, as JSON, for example \`{"customer": "{{ name }}"}\`.
- **Save outputs to**: a variable that receives its \`out\` arguments as an object, for example \`result.total\`.

It runs in the same run, so an open browser stays open between the two workflows. Test cases use Call Workflow to run the workflow they test.

## Other useful actions

In the **System** group:
- **Log Message**: writes a message to the job log, with a level (debug, info, warn or error).
- **Delay**: waits a number of milliseconds (default 1000).
- **Comment**: a note on the canvas. It does nothing when the workflow runs.

## Putting it together

A typical robust pattern:

1. **Try / Catch**
   - try: **Open Browser**, log in, **For Each** row: fill the form and **Click** Save.
   - catch: **Log Message** \`Failed: {{ error.message }}\`, then **Take Screenshot**.
   - finally: **Close Browser**.`,
  },

  /* ------------------------------------------------------------------ */
  {
    id: "test-cases",
    title: "Test cases",
    summary: "Build tests with checks, organise them in folders, and run them",
    body: `Test cases check that an application or a workflow works. They are built like workflows, with steps, and they add checks from the **Verify** group.

## Workflows and test cases

- A **workflow** does work: it enters invoices, copies data, sends emails. You publish it and run it from the Portal.
- A **test case** checks something: that a page shows the right text, that a login works, that a workflow gives the right result. It **passes** when its run succeeds and every check holds, and **fails** otherwise.

Test cases are not published. You run them from the Designer.

## The Test cases tab

On the Designer's start screen, click the **Test cases** tab. On the left is a tree of folders and test cases. At the top are **▷ Run all**, **+ New folder** and **+ New test case**.

Right-click in the tree for more:
- On empty space or **All test cases**: **New folder**, **New test case**, **Run all**.
- On a folder: **New subfolder**, **New test case**, **Run this folder**, **Rename**, **Delete**.
- On a test case: **Open**, **Run**, **Rename**, **Delete**.

Deleting a folder deletes its subfolders and test cases too.

Each test case shows a dot with its last result: **Passed**, **Failed**, **Running**, **Waiting**, **Cancelled** or **Not run yet**.

## Build a test case

1. Click **+ New test case** and give it a name.
2. Click **Open**. The editor opens with a **Test case** badge in the toolbar.
3. Add steps as in a workflow: **● Record**, drag actions, or **✨ Build with AI**.
4. Add checks from the **Verify** group.
5. To test one of your workflows, add **Call Workflow**, choose it, and give it inputs. Then check its outputs with **Verify Condition**.
6. Click **Save**, then **▶ Run**.

## Generate tests with AI

AI can write a website's test cases for you. It looks at the real site through one of your bot PCs, so it also works for sites only your network can reach (for example \`http://192.168.1.106\`). It needs the ZamTech AI Agent 0.3.8 or newer on that PC.

1. In the **Test cases** tab, click **✨ Generate tests with AI**.
2. Enter the **Website address**.
3. Choose how to handle **Signing in**:
   - **No sign-in needed**.
   - **Sign in with steps I already have**: pick a test case or workflow that opens the site and signs in (for example your login test). It runs first on the PC, and every new test starts with it.
   - **I sign in myself in the browser**: the browser opens on the PC with a bar at the top. Sign in (or open the page to start from), then click **Start exploring**. Choose a credential under **The tests sign in with**, so the new tests can sign in by themselves when they run.
4. Optionally say **What to test**, for example "the orders list and its filters".
5. Choose how many **Tests to write**, how many **Pages to explore**, and the PC. Click **Explore and write tests**.

The PC visits the site's pages by following its links and sends each page's fields, buttons, links, text and screen. It never presses buttons or sends forms, and skips sign-out, delete and download links. AI then writes the tests, which takes one or two minutes. Each test checks one thing, with real selectors from the pages and Verify steps.

Untick the tests you do not want, choose the folder, and click **Create**. With **Run them now** ticked, they run straight away. Open a test to see or change its steps, like any other test case. AI's first draft is a starting point: check that each test verifies what matters to you.

## Verify actions

- **Verify Text**: the text of an element on the page. **Match** can be \`contains\`, \`equals\` or \`regex\`.
- **Verify Element Visible**: an element is visible (or, with **Should be visible** unticked, that it is not).
- **Verify Page Title** and **Verify Page URL**: the page's title or address.
- **Verify Text (Desktop)**: the text of an element in a Windows application.
- **Verify Element Exists (Desktop)**: an element exists in a Windows application (or, unticked, that it is gone).
- **Verify Condition**: any expression, for example \`total > 0 && status == "Paid"\`, with a **Message if it fails**.

The web and desktop checks wait up to their **Timeout (ms)** (default 5000) for the check to hold, so they cope with pages that load slowly.

## Running tests

- **▶ Run** in the editor runs one test case (with test data: its first row).
- **Run** on a test case, **Run this folder**, or **▷ Run all** runs several at once (with test data: every row).
- A **schedule** runs test cases at set times, for example every night (see **Processes and schedules**).

Each test runs as a job on an available PC, like any other run. Tests from Run all or Run this folder run one after another as PCs become free.

## Test data: one test, many rows

A data-driven test runs once for each row of a table, for example a login test with 50 user names.

1. In the **Test cases** tab, click the test case. Under **Test data**, click **Add test data**.
2. Each **column** is a variable. Give columns names such as \`username\` and \`password\` (letters, digits and _, not starting with a digit).
3. Type the rows, or click **Import CSV or Excel**. The first row of the file names the columns; names with spaces or other characters are changed (\`First name\` becomes \`First_name\`). Up to 1,000 rows.
4. Click **Save**.
5. In the test's steps, use a column like any variable: \`{{ username }}\` in **Type Into**, or in a check.

**Run** in the Test cases tab (or a schedule) runs every row; each row is its own job, and the results list each row with its first value, for example "Login · row 2: bob". **▶ Run** in the editor tries the first row only. Every row counts as one run of your plan.

Keep passwords out of test data: anyone who can open the test case can read it. Store them in **Assets** as a credential and use **Get Asset** instead.

## Test reports

Open **Test reports** in the Portal to see how your tests do over time, for the last 7, 30 or 90 days and for all folders or one:
- **Pass rate**, tests run, failures, **flaky tests** (passed and failed among their last 10 results, often a timing problem), and the average time.
- **Results per day**, as a chart.
- Each test with its latest results (green and red dots), pass rate, runs and average time. Sort by the lowest pass rate, the slowest or the most runs.
- **Most common failures**: alike error messages counted together, with the tests they happened in.
- **Test runs**: each run with **Open report**, a page to read, print or save as PDF, with the screen of every failed test. **Download** saves it as a file to share.

**Download CSV** saves the numbers per test for a spreadsheet. In the Designer, each test run has a **📄 Report** link too.

## Test runs and results

The Test cases tab also shows **Test runs**: recent runs with each test case's result. Click **View job** to open the job in the Portal, with its log and step screenshots. A failed test's message says what went wrong, for example which check failed.

Test runs also appear in the Portal under **Jobs**, with the source **test**. They count toward your monthly runs.

When a test fails, open it and use **✨ Fix with AI** in the Run panel to find the cause.

## Older test cases

Test cases created before steps were available work differently: they pick a **Workflow to test**, fill its **Inputs**, and list **Expected outputs**. Such a test passes when the run succeeds and each output you filled in has exactly that value; empty fields accept any value.

## Saving tests on your PC

**Export project** on the start screen saves all workflows, test folders and test cases in one file. **Import from PC** brings them back.`,
  },

  /* ------------------------------------------------------------------ */
  {
    id: "alerts-reports-audit",
    title: "Alerts, test reports and the audit log",
    summary: "Hear about failures by email, Slack or Teams; follow test results; see who did what",
    body: `## Alerts

Alerts tell you when something needs attention, so nobody has to watch schedules. Until an admin sets them up, failed runs are emailed to the workspace's admins.

An **Admin** sets them up in the Portal under **Settings**, **Alerts**:

**Send an alert when**
- **A process run fails**: started by a schedule, the API or someone in the Portal.
- **Test runs started by a schedule or a CI pipeline**: **Only when a test fails**, **Every time**, or **Never**.
- **A bot PC goes offline** (off by default: PCs that are switched off at night would send one every evening).

A schedule that could not start at all (for example, no runs left this month) is reported too. Runs you start yourself in the Designer are not reported: you see them as they happen.

**Send it to**
- **Email addresses**, separated by commas. A team mailbox works too.
- **Slack**: in Slack, add the **Incoming Webhooks** app to a channel and paste the webhook address (\`https://hooks.slack.com/...\`).
- **Microsoft Teams**: in the channel's **...** menu, choose **Workflows**, then **Post to a channel when a webhook request is received**, and paste the address it gives you.

Click **Save**, then **Send a test alert** to check each one; the page says whether each was sent. Once saved, a Slack or Teams address is shown shortened: it works like a password. **Remove** takes it away.

An alert says what failed, the error and the step, who started it, the PC and when, with a button to open the job (with its log and screenshots) or the test report. To repair a failed run, open it in the Designer and use **Fix with AI**. Emails include the screen at the moment it failed. At most 30 alerts are sent per workspace an hour, so a schedule that fails every minute does not flood anyone.

## Test reports

See **Test cases** for **Test reports** in the Portal: pass rate over time, flaky tests, the most common failures, and a report of each test run to print, save as PDF or download.

## Audit log

**Admins** open **Audit log** in the Portal to see who did what, and when:
- Changes: workflows (created, changed, published, deleted), processes, schedules, assets, users and roles, queues, test cases, PCs approved or removed, install keys, API tokens, security, SSO, alerts, Git and environment settings.
- Runs started, cancelled or run again, test runs, and imports and exports (including exporting the audit log itself).
- Sign-ins, how the person signed in (password, code or company sign-in), sign-ins that failed, and sign-outs.
- Requests someone was not allowed to make (**Not allowed**).

Each line shows when, who, what, which record (its name at that moment), the result and the IP address. The same person saving the same thing several times within 10 minutes is one line with a count (×3). Search by a name, an action or an IP address, pick dates with **From** and **To**, and click **Export CSV** to save what is shown.

Values are never recorded: no passwords, secrets or asset values, only which record changed and a few safe facts (for example a new role). Entries are kept for about a year, up to 20,000 per workspace.`,
  },

  /* ------------------------------------------------------------------ */
  {
    id: "running-jobs",
    title: "Running jobs",
    summary: "Runs from the Designer, the Jobs page, logs, screenshots and why a run waits",
    body: `Every run of a workflow is a **job**. A job runs on one bot PC. You can follow it live in the Designer or in the Portal.

## Run from the Designer

Click **▶ Run**. The Designer saves the workflow and sends it to an available PC. The **Test run** panel shows the status, the log and the outputs. Click **Stop** to end it.

## Start from the Portal

Published workflows are started from **Processes** with **▶ Start** (see **Processes and schedules**). Schedules start jobs at set times.

## The Jobs page

In the Portal, open **Jobs**. It lists every run, newest first, with the process, status, source, when it was created, how long it took, and whether selectors were healed.

- Filter by status with the list at the top (**All statuses**, pending, running, succeeded, failed, cancelled).
- The source shows who started it: **manual**, **schedule**, **designer**, **API** or **test**.

Row buttons:
- **▷ Run** runs it again, with the same inputs and PC.
- 🗑 deletes the run and its log. Stop a running job first.

**▷ Run all** runs each workflow in the list again, once, with the inputs and PC of its latest run.

## A job's details

Click a job to open it. You see:
- Status, source, **Started by**, duration and creation time.
- **Inputs** and **Outputs**.
- **AI self-healed selectors**: selectors that broke and were repaired by AI, with the old and new selector and the reason. Update them in the Designer to make the fix permanent.
- **Screenshots**: the screen after each browser or desktop step. When a step failed, the screen at that moment is shown first ("The screen when ... failed"). Click a screenshot to enlarge it, and use **Previous** and **Next**.
- **Log**: every message, live while the job runs.

**Cancel job** stops a job that is pending or running.

## Who can do what

Viewers can see jobs. Operators can start, run again and cancel jobs of published processes. Running again a Designer test run, and deleting jobs, needs a Developer or Admin.

## Why a run waits

A job stays **pending** until a PC takes it. The Designer's Run panel says why:

- **"No PC is connected to this account."** Install the agent from the Portal (**Bot Agents**), or sign in with the account your PC was approved for.
- **"Your PCs are offline."** or **"PC-01 is offline."** Start the ZamTech AI Agent on the PC (it is in the system tray).
- **"This run needs a PC in Test, and none is online."** or **"PC-01 does not take Test jobs."** With environments on, each PC runs only its own environment's jobs. In the Portal, open **Bot Agents** and set a PC's environment.
- **"Waiting for a PC to finish its current job..."** A PC runs one job at a time. The job starts when it is free.
- **"Waiting for a PC to start the run..."** A PC is free and is about to start.

## Environments of PCs

With **Development, Test and Production** switched on (see **Environments, Git and CI/CD**), each PC belongs to one environment. New PCs start in **Production**. Runs from the Designer of work that is not published run in **Development**, so you need at least one Development PC to try your work. An Admin sets each PC's environment on **Bot Agents**.

## Runs and your plan

Every job counts as one run: started by hand, by a schedule, through the API, from the Designer, or as a test. See **Plans and billing**.`,
  },

  /* ------------------------------------------------------------------ */
  {
    id: "processes-schedules",
    title: "Processes and schedules",
    summary: "Publish versions, start jobs from the Portal, and run them on a timetable",
    body: `A **process** is a published, versioned workflow that is ready to run. Operators start processes in the Portal without opening the Designer.

## Publish a workflow

1. Open the workflow in the Designer.
2. Click **Publish**. If there are design issues, the Designer asks whether to publish anyway.
3. Enter **Release notes (optional)**, such as what changed.
4. The Designer says "Published v3 - start it from the Portal".

Each publish creates a new version: v1, v2, v3. A version never changes. Keep working in the Designer; the published version is not affected until you publish again.

Deleting a workflow in the Designer keeps its published versions.

## The Processes page

In the Portal, open **Processes**. It lists each process with its version, inputs and when it was published. Release notes appear under the name.

- **Show all versions** lists older versions too.
- **Delete** removes a version.

With environments on, there is a tab for **Development**, **Test** and **Production**. Each shows the version that runs there. See **Environments, Git and CI/CD**.

## Start a job

1. On **Processes**, click **▶ Start** next to the process.
2. Fill in its inputs (its \`in\` arguments). If it has none, the dialog says "This process has no input arguments."
3. In **Run on**, choose a PC or leave **Any available agent**.
4. Click **Start job**.

The job appears under **Jobs**. With environments on, the dialog says in which environment it runs.

## Schedules

Schedules start a process, or run test cases, automatically. They are part of the Pro and Enterprise plans. On the Free plan, schedules are kept but paused.

### Create a schedule

1. In the Portal, open **Schedules** and click **+ New schedule**.
2. Enter a **Name**.
3. In **What to run**, choose:
   - **A process**, then the process. Only published workflows are listed: open the workflow in the Designer and click **Publish** first.
   - **Test cases**, then **All test cases**, a 📁 folder (with its subfolders) or one 🧪 test case. It runs like **Run all** in the Designer, and its results appear in the Designer's **Test cases** tab and in **Test reports**.
4. Enter a **Cron expression**, or click a preset: **Every 5 minutes**, **Hourly**, **Weekdays 09:00**, **Daily 06:00** or **Mondays 08:00**.
5. **Time zone**: pick one from the list or type one, such as \`America/Chicago\` or \`Africa/Nairobi\`. The usual abbreviations work too: \`CST\`, \`EST\`, \`PST\`. It starts with your computer's time zone. Empty means the server's time.
6. With environments on, choose the **Environment**.
7. **Run on**: a PC, or **Any available agent**.
8. Click **Save**.

When a scheduled run fails, the workspace's admins get an email (see **Alerts, test reports and the audit log**).

### Cron expressions

A cron expression has five parts: minute, hour, day of month, month, day of week.

- \`*/5 * * * *\`: every 5 minutes.
- \`0 * * * *\`: every hour, on the hour.
- \`0 9 * * 1-5\`: weekdays at 09:00.
- \`0 6 * * *\`: every day at 06:00.
- \`0 8 * * 1\`: Mondays at 08:00.
- \`30 17 1 * *\`: the 1st of every month at 17:30.

### Manage schedules

The list shows each schedule's cron, **Next run**, **Last run** and whether it is **Enabled**.

- **Run now** starts the process at once.
- Untick **Enabled** in the list to pause it; tick it to resume.
- **Edit** changes it.
- **Delete** removes it.

Scheduled jobs show the source **schedule** on the **Jobs** page and count toward your monthly runs.

## Tips

- Use a schedule with a work queue to process a backlog: one process adds items, another runs every few minutes and handles them (see **Work queues**).
- Give PCs that run schedules the **Start the agent when I sign in to Windows** option, so they are online after a restart.`,
  },

  /* ------------------------------------------------------------------ */
  {
    id: "queues",
    title: "Work queues",
    summary: "Share items of work between bots, with automatic retries",
    body: `A **work queue** holds items of work that wait for bots: one item per invoice, order or customer, for example. Queues let you split a job into a part that finds the work and a part that does it, and let several PCs share the work. Failed items are retried automatically.

## Create a queue

1. In the Portal, open **Queues** and click **+ New queue**.
2. Enter a name. Use letters, digits, spaces, \`.\`, \`_\` or \`-\`.
3. Set **Retries on failure** (0 to 10, default 2): how many times a failed item is tried again before it stays failed. Business exceptions are never retried.
4. Save.

## Items and their status

Each item has:
- **Data**: any JSON, for example \`{"invoice": "INV-1001", "amount": 250}\`.
- **Reference** (optional): a business key such as an invoice number. It must be unique in the queue, so the same invoice is not added twice.
- A status: **new**, **in progress**, **successful**, **failed** or **business exception**.

Click a queue to see its items. Filter them by status (**All items** shows everything). Click **Retry** to send a failed item, or a business exception, back to the queue. Click **+ Add item** to add one by hand.

## The queue actions

The **Work Queues** group in the palette has three actions.

### Add Queue Item

Adds an item to a queue.
- **Queue**: the queue's name.
- **Data**: the item's data, for example \`{"invoice": "{{ row.number }}"}\`.
- **Reference**: optional. Duplicates are rejected.
- **Save item id to**: optional variable.

### Get Next Queue Item

Takes the oldest waiting item and locks it for this job, so no other bot takes it.
- **Queue**: the queue's name.
- **Save item to**: a variable, for example \`item\`. Use \`item.data\` and \`item.reference\` in later steps.

When the queue has no work, the result is empty. Check for it with an **If**: condition \`item\`, or \`!item\` to stop.

### Set Queue Item Result

Marks the item as done.
- **Item**: the item from Get Next Queue Item (for example \`item\`), or its id.
- **Status**:
  - \`successful\`: the work is done.
  - \`failed\`: something technical went wrong (the site was down). The item goes back to the queue until its retries are used up.
  - \`business-exception\`: the data is wrong (the invoice has no total). It is never retried.
- **Result data** (optional): JSON to keep with the item.
- **Message**: the reason for a failure or business exception.

If a job ends while it still holds an item, the item counts as failed and is retried if allowed.

## A typical pattern

**Process 1, "Collect invoices"** (runs every morning):
1. **Read Excel** into \`rows\`.
2. **For Each** \`rows\`: **Add Queue Item** with Data \`{"number": "{{ item.Number }}", "amount": "{{ item.Amount }}"}\` and Reference \`{{ item.Number }}\`.

**Process 2, "Enter invoices"** (runs every 5 minutes, on one or more PCs):
1. **Assign** \`more\` = \`true\`.
2. **While** \`more\`:
   - **Get Next Queue Item** into \`item\`.
   - **If** \`!item\`: **Assign** \`more\` = \`false\`, then **Break**.
   - **Try / Catch**:
     - try: enter the invoice using \`item.data\`, then **Set Queue Item Result** with \`successful\`.
     - catch: **Set Queue Item Result** with \`failed\` and Message \`{{ error.message }}\`.

Remember to declare \`more\` and \`item\` under **Variables & arguments**.`,
  },

  /* ------------------------------------------------------------------ */
  {
    id: "assets",
    title: "Assets",
    summary: "Store settings and credentials once, and read them in workflows",
    body: `**Assets** are shared settings and credentials that your automations use: a website address, a folder path, a limit, or a user name and password. You store them once in the Portal. Workflows read them with the **Get Asset** action. You never need to put a password in a workflow.

## Types

- **Text**: for example a URL or a folder.
- **Number**: for example a maximum amount.
- **Boolean**: true or false, for example a switch to send emails.
- **Credential**: a **Username** and a **Password**.

## Create an asset

1. In the Portal, open **Assets** and click **+ New asset**.
2. Enter the **Name**.
3. Choose the **Type** and enter the value (for a credential, the username and password).
4. With environments on, choose the environment (see below).
5. Save.

### Names

Use letters, digits, \`.\`, \`_\`, \`-\` and \`/\`. The slash lets you group assets like folders, for example:

- \`VideoInsight/Login\`
- \`VideoInsight/BaseUrl\`
- \`Finance/ERP.Password\`

A name cannot start or end with \`/\`. Names are exact: \`erp-login\` and \`ERP-Login\` are different assets.

### Passwords stay hidden

The Portal shows a credential as \`username / ********\`. When you edit it, leave the password as \`********\` to keep the current one. Nobody can read a stored password back in the Portal: only the bot PC receives it when a step needs it. Developers and Admins can create and change assets; everyone else can see the list.

## Use an asset in a workflow

Add **Get Asset** (in the **System** group):
- **Asset name**: the exact name, for example \`VideoInsight/Login\`.
- **Save value to**: a variable, for example \`login\`.

Then use the value:
- Text, number or boolean: \`{{ baseUrl }}\`.
- Credential: \`{{ login.username }}\` and \`{{ login.password }}\`, for example in two **Type Into** steps.

**Send Email** and **Read Emails** take the name of a credential asset directly in their **Credential asset** field.

The value is fetched by the bot PC when the step runs. It is not saved in the workflow, and it is never sent to AI. AI only knows asset names and types.

## Assets per environment

With **Development, Test and Production** switched on, an asset can be for **Every environment** or for one environment. An asset for one environment is used there instead of the one with the same name for every environment.

For example:
- \`ERP/Login\` for **Every environment**: the real account.
- \`ERP/Login\` for **Test**: a test account.

Test PCs get the test account; all other PCs get the real one.

## When an asset is missing

If the name is wrong or the asset does not exist, the step fails with \`Asset "..." not found\`. Check:
- The spelling, including upper and lower case and slashes.
- That the asset exists in this workspace.
- With environments on, that it exists for **Every environment** or for the PC's environment.

**✨ Fix with AI** can spot a missing asset. It shows a card to create it; you type the value yourself.

## Good practice

- Store every password as a credential asset. Recorded passwords become inputs; replace them with Get Asset before going live.
- Use folders in names to keep many assets tidy.
- Give each environment its own test credentials.`,
  },

  /* ------------------------------------------------------------------ */
  {
    id: "cicd",
    title: "Environments, Git and CI/CD",
    summary: "Development, Test and Production, approvals, Git and API tokens",
    body: `Teams can manage automations the way software teams manage code. Environments, Git and API tokens are part of the Pro and Enterprise plans. Set them up in the Portal under **Source control**.

## Environments

With environments, you build and try automations in **Development**, check them in **Test**, and run them for real in **Production**.

### Switch them on

1. In the Portal, open **Source control**.
2. Tick **Use Development, Test and Production**.
3. Leave **Putting a version in Production needs an admin's approval (not the person who asks)** ticked, unless your workspace has only one admin.
4. Open **Bot Agents** and choose each PC's environment. PCs start in Production, so jobs keep running while you set this up.

With environments on:
- **Publish** in the Designer puts a new version in **Development** ("Published version 3 to Development").
- Each PC runs only its own environment's jobs.
- Runs from the Designer of work that is not published run in Development.
- Assets can have a value for one environment (see **Assets**).

Switching environments off returns to one environment: everything published runs on every PC.

### Promote a version

On **Processes**, each environment has a tab showing the version that runs there.

1. On the **Development** tab, click **Promote to Test**.
2. Check it in Test: run it on a Test PC, or run your test cases.
3. On the **Test** tab, click **Ask to put in Production** and add a note for the approver, such as what was tested.
4. Admins get an email. The request appears under **Waiting for approval** at the top of **Processes**.
5. Another admin clicks **Approve** or **Reject**. The person who asked cannot approve their own request, and can **Withdraw** it.

A version must be in Test before it can go to Production. To roll back, promote an older version again.

Schedules and **▶ Start** run the version of the environment you choose.

## Git (source control)

Keep your workflows in GitHub, GitLab or Azure DevOps: one JSON file per workflow, with its history.

### Connect a repository (admins)

1. Create an access token that can read and write the repository:
   - GitHub: a fine-grained token with **Contents** read and write.
   - GitLab: \`write_repository\`.
   - Azure DevOps: **Code** read and write.
2. Under **Source control > Git repository**, enter the **Repository address (HTTPS)**, the **Branch**, the **Folder for workflows** and the **Access token**. Click **Connect**.

### In the Designer

- **Commit** saves the workflow and commits it to Git with your message.
- **History** lists its commits. **Open this version** loads an older version; save it to go back to it.

### Getting changes

- **Get changes from Git** reads the repository: changed files update their workflows and new files become new workflows. Deleting a file in Git does not delete the workflow.
- **Publish on push (webhook)**: add the **Payload URL** and **Secret** shown on the page as a push webhook in your repository (GitHub: Secret; GitLab: Secret token; Azure DevOps: header \`X-Zamtech-Token\`). With **Publish changed workflows to Development when someone pushes** ticked, each push publishes the changed workflows.

## API tokens for CI pipelines

Pipelines such as GitHub Actions or Azure Pipelines can check, publish and promote workflows with an API token.

1. An admin opens **Source control > API tokens for CI pipelines**.
2. Enter a name, choose its role (Developer, Operator or Viewer) and **Valid for (days)**, then click **Create token**.
3. Copy the token now and store it as a secret in your CI. It is not shown again.

Tokens never have admin rights and cannot approve Production. **Revoke** stops a token at once.

Pipelines call the API with the header \`Authorization: Bearer <token>\`:
- \`POST /api/ci/validate\` checks a workflow file.
- \`POST /api/ci/publish\` saves and publishes a workflow to Development.
- \`POST /api/packages/{id}/promote\` with \`{"to": "test"}\` or \`{"to": "prod"}\` promotes a version. Production waits for approval in the Portal.
- \`GET /api/promotions/{id}\` shows whether a request was approved.
- \`POST /api/jobs\` starts a job, for example a check in Test.

If both the webhook and a pipeline publish on push, turn off the webhook's publishing, or each push is published twice.`,
  },

  /* ------------------------------------------------------------------ */
  {
    id: "users-security",
    title: "Users and security",
    summary: "Roles, adding people, two-step sign-in, company sign-in and your data",
    body: `Each person has their own account in your workspace, with a role that decides what they can do.

## Roles

- **Viewer**: read-only access to processes, jobs and logs.
- **Operator**: everything a Viewer can do, plus start and stop jobs, run schedules now, run jobs again, and add and retry queue items.
- **Developer**: build, test and publish workflows; manage schedules, queues and assets; approve new bot PCs; promote versions to Test and ask for Production.
- **Admin**: full access, including users, billing, install keys, removing bot agents, setting each PC's environment, approving Production, company sign-in and exporting data.

Developers and Admins are **builders**: each one uses a builder seat on your plan. Operators and Viewers are free.

If you try something your role does not allow, you see: "You don't have permission to do that. Ask an administrator for a role with more access."

## Add people (admins)

1. In the Portal, open **Users** and click **+ New user**.
2. Enter the person's **Name**, **Email** and **Role**.
3. Enter a starting **Password** (at least 10 characters) and give it to them safely. They can change it under **Settings > Your account > Change password**.

On the Users page you can also **Edit** a person, **Disable** or **Enable** them, **Reset two-step** sign-in, or **Delete** them. A workspace always keeps at least one active Admin. Disabling someone or changing their password signs them out.

## One sign-in per person

An account can be signed in on one browser or PC at a time. Signing in elsewhere signs the other browser out, with a message saying why. Do not share accounts: create one for each person.

## Email confirmation

When you create a workspace, we email you a link to confirm your address. Open it to start using ZamTech AI. You can ask for **Send the link again**. Links expire; if one has, ask for a new one.

## Two-step sign-in

Two-step sign-in adds a 6-digit code from an authenticator app when you sign in.

1. In the Portal, open **Security** and click **Set up two-step sign-in**.
2. Scan the code with Google Authenticator, Microsoft Authenticator or a similar app. Or enter the key by hand.
3. Enter the 6-digit code and click **Turn on**.
4. Save your recovery codes (**Download codes**). Each code signs you in once if you lose your phone. They are shown only now.

To sign in with a recovery code, choose **Use a recovery code instead**. You can make **New recovery codes** at any time. To turn two-step sign-in off, click **Turn off** and enter your password.

Lost your phone and your codes? Ask an admin to click **Reset two-step** for you. You are signed out and set it up again.

Admins can tick **Require two-step sign-in for everyone in this workspace**. People without it set it up at their next sign-in.

## Company sign-in (SSO)

On the Enterprise plan, people can sign in with Microsoft Entra ID, Okta or Google Workspace. An admin sets it up under **Security > Company sign-in (SSO)**:

- Enter the **Issuer URL**, **Client ID** and **Client secret** from your identity provider, and add the **Redirect URI** shown there to your provider.
- Choose the **Role for new people** and whether to **Create accounts on first sign-in**.
- Optionally tick **Require company sign-in (no passwords for these domains)**.
- ZamTech AI adds your company's email domains after checking you own them. Contact us to add them.

People then click **Continue with company sign-in** on the sign-in page.

## Export your data (admins)

**Security > Export your data > Download export** saves everything in your workspace as a JSON file: people, workflows, processes, schedules, queues, jobs and their logs. Passwords and secrets are left out.

## Platform owner

The **Platform owner** badge is only for the admins of ZamTech AI's own workspace. They look after the whole platform: every customer's workspace, plans and backups, on the **Customers** page. Platform owners need two-step sign-in. Customer workspaces do not have this role.`,
  },

  /* ------------------------------------------------------------------ */
  {
    id: "plans-billing",
    title: "Plans and billing",
    summary: "What Free, Pro and Enterprise include, and how usage is counted",
    body: `ZamTech AI has three plans. You pay only for the people who build automations and the PCs that run them.

## Free

For trying ZamTech AI. The Designer is fully usable.

- 1 builder seat (a Developer or Admin)
- 1 bot PC
- 100 runs a month
- 20 AI requests a month
- Designer with recorder, Portal and Windows bot
- Schedules are kept but paused
- No install keys, company sign-in, environments, Git or API tokens

No card is needed.

## Pro

Priced per builder seat and per bot PC, monthly or yearly.

- As many builder seats and bot PCs as you pay for
- 5,000 runs a month for each bot PC
- 500 AI requests a month for each builder seat
- Schedules included
- Development, Test and Production environments, Git and API tokens

For example, 2 builder seats and 3 bot PCs give 15,000 runs and 1,000 AI requests a month.

Install keys and company sign-in are not part of Pro.

## Enterprise

Limits and support agreed with you, invoiced yearly.

- Company sign-in with Microsoft Entra ID, Okta or Google Workspace
- Install keys for silent installs on many PCs
- Everything in Pro
- Priority support

Click **Contact sales** on the Billing page to ask about Enterprise.

## What counts

- **Builder seats**: active users with the Developer or Admin role. Operators and Viewers are free. Disabled users do not count.
- **Bot PCs**: PCs connected to your workspace. Remove a PC under **Bot Agents** to free its place. Approving a reinstalled PC brings back its old bot and does not use another place.
- **Runs**: every job started in a calendar month, whether by hand, by a schedule, through the API, from the Designer, or as a test case. Running a job again is a new run.
- **AI requests**: each use of **Build with AI**, **Fix with AI** (on design issues or a failed run) and **AI selector suggestions**.

Runs and AI requests reset at the start of each calendar month.

## When you reach a limit

- Runs used up: new jobs are refused with "This month's ... runs are used up."
- AI requests used up: AI buttons show "This month's ... AI requests are used up."
- All bot PCs connected: approving another PC is refused. Remove one, or add bot PCs to your plan.
- All builder seats used: you cannot add or promote another Developer or Admin.

Each message says: "Upgrade your plan under Billing in the Portal."

## The Billing page

Admins open **Billing** in the Portal. It shows:

- Your **Current plan**.
- What you use against your limits: **Builder seats**, **Bot PCs**, **Runs this month** and **AI requests this month**.
- Whether **Schedules** and **Install keys** are included.

### Upgrade to Pro

1. Under **Upgrade to Pro**, choose **Monthly** or **Yearly**.
2. Choose the number of builder seats and bot PCs. The page shows the price per builder seat, per bot PC, and the total.
3. Click **Continue to payment** and pay on Stripe's secure page.
4. Back in the Portal, your plan updates in a moment.

### Manage billing

On Pro, **Manage billing** opens Stripe's secure page, where you can change seats, update your card or download invoices. The Billing page shows when your plan renews or ends. If a payment fails, a message asks you to update your card to keep Pro.

Prices are shown on the Billing page and on the website's pricing page.`,
  },

  /* ------------------------------------------------------------------ */
  {
    id: "troubleshooting",
    title: "Troubleshooting",
    summary: "Runs that wait, offline PCs, missing assets, elements not found, and getting help",
    body: `Start with the message on screen: it usually says what is wrong and what to do.

## A run stays pending

A job waits until a PC takes it. The Designer's Run panel says why:

- **"No PC is connected to this account."** No PC is approved for your workspace. Install the agent (Portal > **Bot Agents** > **⬇ Download for Windows**) and approve it. If your PC was approved while you were signed in to another account, sign in with that account.
- **"Your PCs are offline."** or **"PC-01 is offline."** Start the ZamTech AI Agent on the PC. Look for its icon in the system tray, or start it from the Start menu.
- **"This run needs a PC in Development, and none is online."** With environments on, runs from the Designer go to Development PCs. An Admin sets a PC's environment on **Bot Agents**.
- **"PC-01 does not take Test jobs."** You chose a PC in another environment. Choose another PC, or change its environment on **Bot Agents**.
- **"Waiting for a PC to finish its current job..."** A PC runs one job at a time. Wait, or stop the other job.
- **"Waiting for a PC to start the run..."** It should start in a few seconds. If not, use **Restart agent** in the tray menu.

## A PC is offline

1. Check that the ZamTech AI Agent is running: its icon is in the system tray. If not, start **ZamTech AI Agent** from the Start menu.
2. Right-click the icon and read the status:
   - **Cannot reach the server - retrying**: check the PC's internet connection. In **Settings...**, click **Test connection**.
   - **Not approved** or **Not connected**: open **Settings...** and click **Connect this PC again**, then approve it in the Portal.
   - **Declined in the Portal**: someone declined it. Connect it again and approve it.
3. If Windows was reinstalled or the agent was uninstalled, approve the PC again. It comes back as the same bot.

Automations run in your Windows session, so the PC must be signed in to Windows.

## "Asset not found"

The step's asset name does not match an asset in the Portal. Check the spelling, including upper and lower case and slashes (\`VideoInsight/Login\`). With environments on, the asset must be for **Every environment** or for the PC's environment. **✨ Fix with AI** can find this and create the asset for you (you type the value).

## Element not found, or the wrong element

The screen changed, or the selector was never right.

1. Click ◎ (**Indicate on screen**) on the step and point at the element again.
2. Make sure the page or window is really open at that moment. Add **Wait For Element** before the step, or raise its **Timeout (ms)**.
3. Give the step a clear **Target description** and keep **AI self-healing** on.
4. Use **✨ Fix with AI** in the Run panel. It reads the log and screenshots and can look at the application on the PC.
5. In the Portal, open the job and look at **Screenshots**: the screen when the step failed often shows the reason, such as a pop-up or a login page.

## A desktop application is not found

- **Start Application** needs the program's name or full path, such as \`notepad.exe\` or \`C:\\Program Files\\App\\app.exe\`. The program must be installed on the PC that runs the job, not only on yours.
- Use **Wait for window** with the window's selector, so the next steps wait until the window is open.
- Check the window part of the selector, for example \`window[process="notepad"]\`. Use ◎ Indicate to get it right.
- Run **Desktop self-test** from the tray menu or the Start menu to check that desktop automation works on the PC.

## "Update the agent"

Recording, Indicate and AI looking at an application need a recent agent. When a PC shows **(update the agent)**, download the latest agent from the Portal (**⬇ Download for Windows**) and install it over the old one. Your connection is kept.

## Agent logs

Open them from the tray icon (**Open log**) or the Start menu (**ZamTech AI Agent > Agent logs**). Include the log when you ask for help.

## Getting help

1. Ask the help assistant in Docs.
2. Contact your administrator. Give the job's link from the Portal, what you expected, and the agent log if a PC is involved.`,
  },
];
