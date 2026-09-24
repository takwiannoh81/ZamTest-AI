/**
 * A workspace's Git repository, through the `git` command line: a working copy
 * per workspace under <data dir>/git, kept in step with the remote branch.
 *
 * The access token never touches the disk or the command line: it is passed as
 * an HTTP header through environment-only git configuration. Only HTTPS remotes
 * are allowed (plus local file:// ones when `allowLocal` is set, for tests), and
 * repository hooks never run.
 */
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, posix, relative, sep } from "node:path";
import { HttpError } from "./errors.js";
import type { GitSettings } from "./types.js";

export class GitError extends HttpError {
  constructor(message: string) {
    super(502, message);
  }
}

export interface GitCommit {
  sha: string;
  message: string;
  author: string;
  date: string;
}

export interface GitFile {
  /** Path inside the repository, with forward slashes. */
  path: string;
  content: string;
}

const TIMEOUT_MS = 60_000;

export class GitRepos {
  private readonly root: string;
  private readonly locks = new Map<string, Promise<unknown>>();
  private readonly emptyDir: string;

  constructor(dataDir: string | null, private readonly options: { allowLocal?: boolean } = {}) {
    this.root = dataDir ? join(dataDir, "git") : mkdtempSync(join(tmpdir(), "zamtech-git-"));
    mkdirSync(this.root, { recursive: true });
    // Hooks point here: an empty folder, so no hook ever runs.
    this.emptyDir = join(this.root, ".no-hooks");
    mkdirSync(this.emptyDir, { recursive: true });
  }

  /** Throws a readable error when the URL is not one we connect to. */
  checkUrl(url: string): void {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new HttpError(400, "Enter the repository's HTTPS address, like https://github.com/acme/automations.git");
    }
    const local = parsed.protocol === "file:" && this.options.allowLocal;
    if (parsed.protocol !== "https:" && !local) throw new HttpError(400, "Only https:// repository addresses are supported");
    if (parsed.username || parsed.password) throw new HttpError(400, "Put the user name and token in their own fields, not in the address");
  }

  /** Runs git operations of one workspace one at a time. */
  private serial<T>(workspaceId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(workspaceId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(task);
    this.locks.set(workspaceId, next);
    return next;
  }

  private dir(workspaceId: string) {
    return join(this.root, workspaceId.replace(/[^A-Za-z0-9_-]/g, "_"));
  }

  private run(settings: GitSettings, args: string[], cwd?: string): Promise<string> {
    const config: Array<[string, string]> = [
      ["core.hooksPath", this.emptyDir],
      // A link in the repository is checked out as a plain file, so writing a workflow file never lands outside it.
      ["core.symlinks", "false"],
      ["protocol.allow", "never"],
      ["protocol.https.allow", "always"],
      ["credential.helper", ""],
      ["http.extraHeader", `Authorization: Basic ${Buffer.from(`${settings.username || "zamtech"}:${settings.token}`).toString("base64")}`],
    ];
    if (this.options.allowLocal) config.push(["protocol.file.allow", "always"]);
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      SYSTEMROOT: process.env.SYSTEMROOT,
      TEMP: process.env.TEMP,
      TMP: process.env.TMP,
      HOME: this.root,
      GIT_TERMINAL_PROMPT: "0",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: join(this.emptyDir, "gitconfig"),
      GIT_CONFIG_COUNT: String(config.length),
    };
    config.forEach(([key, value], i) => {
      env[`GIT_CONFIG_KEY_${i}`] = key;
      env[`GIT_CONFIG_VALUE_${i}`] = value;
    });
    return new Promise((resolve, reject) => {
      execFile("git", args, { cwd, env, timeout: TIMEOUT_MS, maxBuffer: 50 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
        if (!err) return resolve(stdout);
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return reject(new GitError("Git is not installed on the server"));
        reject(new GitError(explain(String(stderr || err.message), settings)));
      });
    });
  }

  /** Checks the address, token and branch (nothing is stored). */
  async test(settings: GitSettings): Promise<void> {
    this.checkUrl(settings.url);
    const out = await this.run(settings, ["ls-remote", "--heads", "--", settings.url]);
    const branches = out.split("\n").map((l) => l.split("\trefs/heads/")[1]).filter(Boolean);
    // An empty repository has no branches yet: the first commit creates it.
    if (branches.length && !branches.includes(settings.branch)) {
      throw new HttpError(400, `The repository has no branch "${settings.branch}" (it has: ${branches.slice(0, 10).join(", ")})`);
    }
  }

  /** Brings the working copy to the remote branch's newest commit. Returns that commit (none for an empty repository). */
  private async sync(workspaceId: string, settings: GitSettings): Promise<string | undefined> {
    this.checkUrl(settings.url);
    const dir = this.dir(workspaceId);
    const fresh = async () => {
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(dir, { recursive: true });
      await this.run(settings, ["init", "--quiet", "--initial-branch", settings.branch], dir);
      await this.run(settings, ["remote", "add", "origin", "--", settings.url], dir);
    };
    if (!existsSync(join(dir, ".git"))) await fresh();
    else await this.run(settings, ["remote", "set-url", "origin", "--", settings.url], dir);
    const heads = await this.run(settings, ["ls-remote", "--heads", "origin", settings.branch], dir);
    if (!heads.trim()) {
      // Empty repository (or a new branch): the first commit starts it.
      await fresh();
      return undefined;
    }
    await this.run(settings, ["fetch", "--quiet", "--depth", "200", "origin", `+refs/heads/${settings.branch}:refs/remotes/origin/${settings.branch}`], dir);
    await this.run(settings, ["checkout", "--quiet", "--force", "-B", settings.branch, `origin/${settings.branch}`], dir);
    await this.run(settings, ["clean", "-fdq"], dir);
    return (await this.run(settings, ["rev-parse", "HEAD"], dir)).trim();
  }

  /** The workflow files (*.json) in the folder, at the branch's newest commit. */
  pull(workspaceId: string, settings: GitSettings): Promise<{ commit?: string; files: GitFile[] }> {
    return this.serial(workspaceId, async () => {
      const commit = await this.sync(workspaceId, settings);
      const dir = this.dir(workspaceId);
      const base = safeJoin(dir, settings.folder);
      const files: GitFile[] = [];
      const walk = (folder: string) => {
        if (!existsSync(folder)) return;
        for (const entry of readdirSync(folder, { withFileTypes: true })) {
          const full = join(folder, entry.name);
          if (entry.isDirectory() && entry.name !== ".git") walk(full);
          else if (entry.isFile() && entry.name.endsWith(".json")) {
            files.push({ path: relative(dir, full).split(sep).join("/"), content: readFileSync(full, "utf8") });
          }
        }
      };
      walk(base);
      return { commit, files };
    });
  }

  /**
   * Writes one file and pushes a commit with it. If someone pushed meanwhile,
   * starts again from their commit (once). Returns undefined when nothing changed.
   */
  commit(
    workspaceId: string,
    settings: GitSettings,
    file: GitFile,
    message: string,
    author: { name: string; email: string },
  ): Promise<string | undefined> {
    return this.serial(workspaceId, async () => {
      for (let attempt = 0; ; attempt++) {
        await this.sync(workspaceId, settings);
        const dir = this.dir(workspaceId);
        const target = safeJoin(dir, file.path);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, file.content);
        await this.run(settings, ["add", "--", file.path], dir);
        const status = await this.run(settings, ["status", "--porcelain", "--", file.path], dir);
        if (!status.trim()) return undefined;
        const identity = ["-c", `user.name=${author.name}`, "-c", `user.email=${author.email}`];
        await this.run(settings, [...identity, "commit", "--quiet", "--no-verify", "-m", message], dir);
        try {
          await this.run(settings, ["push", "--quiet", "origin", `HEAD:refs/heads/${settings.branch}`], dir);
        } catch (err) {
          if (attempt === 0 && /rejected|non-fast-forward|fetch first/i.test((err as Error).message)) continue;
          throw err;
        }
        return (await this.run(settings, ["rev-parse", "HEAD"], dir)).trim();
      }
    });
  }

  /** Commits that changed a file, newest first. */
  history(workspaceId: string, settings: GitSettings, path: string, limit = 50): Promise<GitCommit[]> {
    return this.serial(workspaceId, async () => {
      if (!(await this.sync(workspaceId, settings))) return [];
      const out = await this.run(
        settings,
        ["log", `-n${limit}`, "--format=%H%x1f%an <%ae>%x1f%aI%x1f%s%x1e", "--", path],
        this.dir(workspaceId),
      );
      return out
        .split("\x1e")
        .map((r) => r.trim())
        .filter(Boolean)
        .map((r) => {
          const [sha = "", author = "", date = "", message = ""] = r.split("\x1f");
          return { sha, author, date, message };
        });
    });
  }

  /** A file as it was at a commit. */
  show(workspaceId: string, settings: GitSettings, sha: string, path: string): Promise<string> {
    if (!/^[0-9a-f]{7,64}$/i.test(sha)) throw new HttpError(400, "Not a commit id");
    return this.serial(workspaceId, () => this.run(settings, ["show", `${sha}:${path}`], this.dir(workspaceId)));
  }

  /** Forgets the working copy (the repository is disconnected). */
  remove(workspaceId: string): void {
    rmSync(this.dir(workspaceId), { recursive: true, force: true });
  }
}

/** A path inside the repository: no absolute paths, no "..". */
export function safeJoin(dir: string, path: string): string {
  const clean = posix.normalize(path.replace(/\\/g, "/")).replace(/^\/+/, "");
  if (clean === ".." || clean.startsWith("../") || /^[A-Za-z]:/.test(clean)) throw new HttpError(400, `Not a path inside the repository: ${path}`);
  return join(dir, clean);
}

/** "Invoice Processing (EU)" -> "invoice-processing-eu". */
export function slugify(name: string): string {
  return (
    name
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "workflow"
  );
}

/** Git's own messages, without the token and with a hint for the usual problems. */
function explain(stderr: string, settings: GitSettings): string {
  const text = (settings.token ? stderr.split(settings.token).join("***") : stderr).trim();
  if (/Authentication failed|401|403|could not read Username|terminal prompts disabled/i.test(text)) {
    return "The repository refused the token. Check that it is valid and can read and write this repository.";
  }
  if (/not found|404|does not appear to be a git repository/i.test(text)) return "Repository not found. Check the address (and that the token can see it).";
  if (/Could not resolve host|Connection refused|timed out/i.test(text)) return "Could not reach the repository's server.";
  return `Git: ${text.split("\n").slice(-3).join(" ").slice(0, 400)}`;
}
