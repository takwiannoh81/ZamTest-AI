# Source control and CI/CD for your automations

Pro and Enterprise workspaces can manage automations the way software teams manage code:

- **Environments.** Build and try in **Development**, check in **Test**, run for real in **Production**. Each bot PC belongs to one environment.
- **Promotion with approval.** A new version goes into Development when it is published. From there it is promoted to Test and then to Production. An admin other than the person who asked approves each step into Production.
- **Git.** Workflows live in your own GitHub, GitLab or Azure DevOps repository, one JSON file per workflow. Developers commit from the Designer and can see each workflow's history. A push can publish the changed workflows to Development.
- **API tokens.** A CI pipeline can check, publish and promote workflows without a person signing in.

Workspace admins set these up in the Portal under **Source control**.

## Environments

1. Under **Source control**, switch on **Use Development, Test and Production**. Leave **Putting a version in Production needs an admin's approval** on, unless your workspace has only one admin.
2. Under **Bot Agents**, choose each PC's environment. PCs start in Production, so jobs keep running while you set this up.
3. Under **Assets**, you can give an asset a value for a single environment, for example test credentials for Test. A PC uses its own environment's asset first. If there is none, it uses the asset of that name marked **Every environment**.

With environments on:

| | Development | Test | Production |
|---|---|---|---|
| How a version gets there | **Publish** in the Designer, CI, or a Git push | **Promote to Test** (developers) | **Ask to put in Production**, then an admin approves |
| Which PCs run its jobs | Development PCs | Test PCs | Production PCs |
| Designer test runs of unsaved work | yes | no | no |

On the **Processes** page:
- Each environment has a tab showing the version that runs there. That is the newest version put there, so an older version can be promoted again to roll back.
- Requests waiting for approval appear at the top. Admins get an email for each request when email is set up.
- Schedules and **Start** run the version of the environment you pick.

Switching environments off returns to one environment: everything published runs on every PC, as before.

## Git

1. **Create a repository**, or use an existing one. Then create a token that can read and write it:
   - **GitHub:** *Settings > Developer settings > Fine-grained tokens*. Pick the repository, with *Contents: Read and write*.
   - **GitLab:** a project or personal access token with `write_repository`.
   - **Azure DevOps:** a personal access token with *Code: Read & write*.
2. **Connect it.** Under **Source control > Git repository**, enter the HTTPS address (for example `https://github.com/acme/automations.git`), the branch, the folder for workflows (default `workflows`) and the token. ZamTech AI checks that it can reach the repository before saving. The token is stored on the server and never shown again.
3. **Set up the webhook**, optional, to publish when someone pushes. The same page shows a **Payload URL** and a **Secret**:
   - **GitHub:** *Settings > Webhooks > Add webhook*. Content type `application/json`, the secret, and *Just the push event*.
   - **GitLab:** *Settings > Webhooks*. The URL, **Secret token** = the secret, trigger *Push events*.
   - **Azure DevOps:** *Project settings > Service hooks > Web Hooks*, event *Code pushed*. Add the HTTP header `X-Zamtech-Token: <secret>`.

   Only pushes to the connected branch count. The changed workflows are published to Development, or to Production while environments are off, if **Publish changed workflows to Development when someone pushes** is on.

In the Designer:
- **Commit** saves the workflow and commits its file with your message and your name.
- **History** lists the workflow's commits. You can open an older version in the editor and save it to go back.

**Get changes from Git**, on the Source control page, reads the repository into the workspace:
- A changed file updates its workflow. A new file becomes a new workflow.
- Files that are not valid workflows are listed and skipped.
- Deleting a file in Git does not delete the workflow here.

Each workflow file is the workflow's JSON, the same format as **Export** in the Designer, formatted for readable diffs and pull requests.

## API tokens and CI pipelines

An admin creates a token under **Source control > API tokens**:
- Its role is Developer, Operator or Viewer, never Admin. An expiry is optional.
- Copy the token (`ztat_...`) when it is shown, and store it as a secret in your CI. It is not shown again.
- API tokens cannot approve a promotion to Production. A person does that.

Endpoints, called with `Authorization: Bearer <token>`:

| Method and path | What it does |
|---|---|
| `POST /api/ci/validate` `{ definition }` | Checks a workflow: `{ valid, errors[] }` |
| `POST /api/ci/publish` `{ definition, releaseNotes?, commit?, path? }` | Saves the workflow (matched by its id, then its name) and publishes a new version to Development: `{ workflowId, package }` |
| `POST /api/packages/{id}/promote` `{ to: "test" \| "prod", note? }` | Promotes a version. The answer is `200` when it is done, or `202` with a pending request when it needs approval |
| `GET /api/promotions/{id}` | The request's status: `pending`, `approved`, `rejected` or `cancelled` |
| `POST /api/jobs` `{ packageId, environment, inputs? }` | Starts a job (for example a smoke test in Test). `GET /api/jobs/{id}` shows how it went |

### Example: GitHub Actions

This workflow checks every workflow file in a pull request. After a merge to `main`, it publishes the changed files and promotes them to Test. Store the token as the repository secret `ZAMTECH_TOKEN`.

```yaml
name: Automations
on:
  pull_request:
    paths: ["workflows/**.json"]
  push:
    branches: [main]
    paths: ["workflows/**.json"]

env:
  API: https://api.zamtechai.com

jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Validate workflows
        env: { TOKEN: "${{ secrets.ZAMTECH_TOKEN }}" }
        run: |
          status=0
          for f in workflows/*.json; do
            result=$(jq -n --slurpfile d "$f" '{definition: $d[0]}' \
              | curl -sf -H "Authorization: Bearer $TOKEN" -H "content-type: application/json" -d @- "$API/api/ci/validate")
            echo "$f: $result"
            [ "$(echo "$result" | jq -r .valid)" = "true" ] || status=1
          done
          exit $status

  publish:
    if: github.event_name == 'push'
    needs: check
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 2 }
      - name: Publish to Development and promote to Test
        env: { TOKEN: "${{ secrets.ZAMTECH_TOKEN }}" }
        run: |
          for f in $(git diff --name-only HEAD~1 HEAD -- 'workflows/*.json'); do
            [ -f "$f" ] || continue
            pkg=$(jq -n --slurpfile d "$f" --arg c "$GITHUB_SHA" --arg p "$f" --arg n "CI ${GITHUB_SHA::7}" \
                '{definition: $d[0], commit: $c, path: $p, releaseNotes: $n}' \
              | curl -sf -H "Authorization: Bearer $TOKEN" -H "content-type: application/json" -d @- "$API/api/ci/publish" \
              | jq -r .package.id)
            curl -sf -H "Authorization: Bearer $TOKEN" -H "content-type: application/json" \
              -d '{"to":"test"}' "$API/api/packages/$pkg/promote"
          done
```

If the repository is also connected under **Source control > Git repository**, turn off **Publish changed workflows to Development when someone pushes**. Otherwise each push is published twice: once by the webhook and once by the pipeline.

Promotion to Production then goes through approval in the Portal. A pipeline can ask for it (`{"to":"prod"}`) and follow the request with `GET /api/promotions/{id}`.
