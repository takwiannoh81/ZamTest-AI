// Builds the Windows installer for the bot agent:
//   pnpm --filter @zamtest/agent build:installer [--stage-only]
//
// 1. Bundles the agent CLI into one file (agent.mjs) next to the desktop driver.
// 2. Adds a Node.js runtime (node.exe, checksum-verified) and Playwright.
// 3. Compiles the tray app (ZamTechAgent.exe) and its icon with the C# compiler
//    that ships with Windows.
// 4. Runs Inno Setup to produce dist/installer/ZamTechAI-Agent-Setup-<version>.exe.
//
// Needs Windows. Inno Setup 6.3+ is only needed for step 4
// (winget install JRSoftware.InnoSetup); --stage-only stops after step 3.
// NODE_VERSION pins the Node.js version (default: latest LTS).
//
// Code signing signs the tray app, the setup file and its uninstaller. Without
// it the build is unsigned and Windows SmartScreen shows "Unknown publisher".
// - ZAMTEST_ARTIFACT_SIGNING=1 signs with Azure Artifact Signing, using the
//   account in installer/artifact-signing.json (or =<path> for another file).
//   Needs the Windows SDK's signtool, the .NET 8 runtime and an Azure sign-in
//   (`az login`) that has the Artifact Signing Certificate Profile Signer role.
// - ZAMTEST_SIGN_COMMAND is any command that signs one file, with {file} where
//   the file name goes, for a certificate from another certificate authority.

import { createHash } from "node:crypto";
import { execFileSync, execSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const agentDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoDir = resolve(agentDir, "../..");
const outDir = join(agentDir, "dist", "installer");
const stage = join(outDir, "app");
const cacheDir = join(agentDir, ".cache");
const installerDir = join(agentDir, "installer");
const stageOnly = process.argv.includes("--stage-only");
const version = JSON.parse(readFileSync(join(agentDir, "package.json"), "utf8")).version;

const step = (message) => console.log(`\n==> ${message}`);
const run = (file, args, options = {}) => execFileSync(file, args, { stdio: "inherit", ...options });
let signCommand = process.env.ZAMTEST_SIGN_COMMAND?.trim();
if (signCommand && !signCommand.includes("{file}")) {
  console.error("ZAMTEST_SIGN_COMMAND must contain {file} where the file to sign goes");
  process.exit(1);
}
const sign = (file) => {
  if (signCommand) execSync(signCommand.replaceAll("{file}", `"${file}"`), { stdio: "inherit" });
};

if (process.platform !== "win32") {
  console.error("The Windows installer has to be built on Windows (it compiles the tray app with the .NET Framework C# compiler).");
  process.exit(1);
}

rmSync(outDir, { recursive: true, force: true });
mkdirSync(join(stage, "logs"), { recursive: true });
mkdirSync(cacheDir, { recursive: true });

/** signtool with the Azure Artifact Signing plug-in (dlib), downloaded from NuGet on first use. */
async function artifactSigningCommand(metadata) {
  if (!existsSync(metadata)) throw new Error(`Artifact Signing settings not found: ${metadata}`);
  const kits = join(process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)", "Windows Kits", "10", "bin");
  const sdkVersions = existsSync(kits)
    ? readdirSync(kits)
        // The plug-in does not work with signtool from the 10.0.20348 SDK.
        .filter((v) => /^10\.\d+\.\d+\.\d+$/.test(v) && v !== "10.0.20348.0" && existsSync(join(kits, v, "x64", "signtool.exe")))
        .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    : [];
  const signtool = process.env.SIGNTOOL ?? (sdkVersions.length ? join(kits, sdkVersions.at(-1), "x64", "signtool.exe") : undefined);
  if (!signtool || !existsSync(signtool)) throw new Error("signtool.exe not found. Install the Windows SDK or set SIGNTOOL to its path.");

  const pkg = "microsoft.artifactsigning.client";
  const versions = JSON.parse((await download(`https://api.nuget.org/v3-flatcontainer/${pkg}/index.json`)).toString("utf8")).versions;
  const latest = versions.filter((v) => !v.includes("-")).at(-1);
  const dir = join(cacheDir, `artifact-signing-${latest}`);
  const dlib = join(dir, "bin", "x64", "Azure.CodeSigning.Dlib.dll");
  if (!existsSync(dlib)) {
    mkdirSync(dir, { recursive: true });
    const zip = join(dir, "package.zip");
    writeFileSync(zip, await download(`https://api.nuget.org/v3-flatcontainer/${pkg}/${latest}/${pkg}.${latest}.nupkg`));
    run(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe"), ["-xf", zip, "-C", dir]);
  }
  return `"${signtool}" sign /v /fd SHA256 /tr http://timestamp.acs.microsoft.com /td SHA256 /dlib "${dlib}" /dmdf "${metadata}" {file}`;
}

const artifactSigning = process.env.ZAMTEST_ARTIFACT_SIGNING?.trim();
if (!signCommand && artifactSigning && artifactSigning !== "0") {
  step("Setting up Azure Artifact Signing");
  signCommand = await artifactSigningCommand(artifactSigning === "1" ? join(installerDir, "artifact-signing.json") : resolve(artifactSigning));
}

/* 1. Agent bundle ----------------------------------------------------------- */
step("Bundling the agent");
await build({
  entryPoints: [join(agentDir, "src", "cli.ts")],
  outfile: join(stage, "agent.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  // Playwright finds its browsers and helper files relative to its own package, so it stays a real package.
  external: ["playwright", "playwright-core"],
  // CommonJS dependencies (exceljs, nodemailer, ...) call require() for Node built-ins.
  banner: { js: 'import { createRequire as __ztCreateRequire } from "node:module"; const require = __ztCreateRequire(import.meta.url);' },
  legalComments: "linked",
  logLevel: "warning",
});
copyFileSync(join(repoDir, "packages", "actions", "src", "desktop", "driver.ps1"), join(stage, "driver.ps1"));

/* 2. Node.js and Playwright -------------------------------------------------- */
async function download(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed: ${url} (HTTP ${res.status})`);
  return Buffer.from(await res.arrayBuffer());
}

async function nodeVersion() {
  if (process.env.NODE_VERSION) return process.env.NODE_VERSION.replace(/^v?/, "v");
  const index = JSON.parse((await download("https://nodejs.org/dist/index.json")).toString("utf8"));
  const lts = index.find((r) => r.lts && r.files.includes("win-x64-zip"));
  if (!lts) throw new Error("Cannot find a Node.js LTS release for Windows x64");
  return lts.version;
}

const nodeVer = await nodeVersion();
step(`Adding Node.js ${nodeVer}`);
const zipName = `node-${nodeVer}-win-x64.zip`;
const zipPath = join(cacheDir, zipName);
const sums = (await download(`https://nodejs.org/dist/${nodeVer}/SHASUMS256.txt`)).toString("utf8");
const expected = sums.split("\n").find((l) => l.trim().endsWith(`  ${zipName}`))?.split(/\s+/)[0];
if (!expected) throw new Error(`No checksum for ${zipName}`);
const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");
if (!existsSync(zipPath) || sha256(readFileSync(zipPath)) !== expected) {
  const zip = await download(`https://nodejs.org/dist/${nodeVer}/${zipName}`);
  if (sha256(zip) !== expected) throw new Error(`Checksum mismatch for ${zipName}`);
  writeFileSync(zipPath, zip);
}
const unzipDir = join(cacheDir, `node-${nodeVer}-win-x64`);
if (!existsSync(join(unzipDir, "node.exe"))) {
  // Windows' own tar (bsdtar) reads zip files; Git Bash's GNU tar does not.
  const tar = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe");
  run(tar, ["-xf", zipPath, "-C", cacheDir, `node-${nodeVer}-win-x64/node.exe`, `node-${nodeVer}-win-x64/LICENSE`]);
}
copyFileSync(join(unzipDir, "node.exe"), join(stage, "node.exe"));
copyFileSync(join(unzipDir, "LICENSE"), join(stage, "NODE-LICENSE.txt"));

const playwrightVersion = JSON.parse(readFileSync(join(agentDir, "node_modules", "playwright", "package.json"), "utf8")).version;
step(`Adding Playwright ${playwrightVersion} (browsers are downloaded by setup when chosen)`);
writeFileSync(join(stage, "package.json"), JSON.stringify({ private: true, dependencies: { playwright: playwrightVersion } }, null, 2));
// pnpm's own npm_config_* settings would confuse npm.
const npmEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^npm_/i.test(k)));
execSync("npm install --omit=dev --no-audit --no-fund --no-package-lock", {
  cwd: stage,
  stdio: "inherit",
  env: { ...npmEnv, PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1" },
});

step("Checking that the bundled agent starts");
const help = execFileSync(join(stage, "node.exe"), [join(stage, "agent.mjs"), "--help"], { encoding: "utf8" });
if (!help.includes("ZamTech AI bot agent")) throw new Error("The bundled agent did not print its help text");

/* 3. Tray app ---------------------------------------------------------------- */
step("Compiling the tray app");
const csc = join(process.env.SystemRoot ?? "C:\\Windows", "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe");
if (!existsSync(csc)) throw new Error(`C# compiler not found at ${csc} (.NET Framework 4 is part of Windows 10/11)`);
const toolsDir = join(outDir, "tools");
mkdirSync(toolsDir, { recursive: true });
run(csc, ["-nologo", `-out:${join(toolsDir, "IconGen.exe")}`, "-r:System.Drawing.dll", join(installerDir, "IconGen.cs")]);
run(join(toolsDir, "IconGen.exe"), [join(stage, "agent.ico")]);
run(csc, [
  "-nologo", "-optimize", "-target:winexe", "-platform:anycpu",
  `-out:${join(stage, "ZamTechAgent.exe")}`,
  `-win32icon:${join(stage, "agent.ico")}`,
  "-r:System.Drawing.dll", "-r:System.Windows.Forms.dll", "-r:System.Web.Extensions.dll", "-r:System.Security.dll",
  join(installerDir, "ZamTechAgent.cs"),
]);
sign(join(stage, "ZamTechAgent.exe"));

if (stageOnly) {
  console.log(`\nStaged the agent in ${stage}`);
  process.exit(0);
}

/* 4. Setup.exe ---------------------------------------------------------------- */
function findIscc() {
  const candidates = [
    process.env.ISCC,
    join(process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)", "Inno Setup 6", "ISCC.exe"),
    join(process.env.ProgramFiles ?? "C:\\Program Files", "Inno Setup 6", "ISCC.exe"),
    join(process.env.LOCALAPPDATA ?? "", "Programs", "Inno Setup 6", "ISCC.exe"),
  ];
  return candidates.find((c) => c && existsSync(c));
}

const iscc = findIscc();
if (!iscc) {
  console.error(`\nInno Setup 6 was not found, so no setup.exe was built (the agent is staged in ${stage}).`);
  console.error("Install it with:  winget install JRSoftware.InnoSetup   (or set ISCC to the path of ISCC.exe)");
  process.exit(1);
}
step(signCommand ? "Building and signing the installer" : "Building the installer (unsigned: set ZAMTEST_SIGN_COMMAND to sign it)");
const isccArgs = ["/Q", `/DAppVersion=${version}`, `/DStage=${stage}`, `/DOutDir=${outDir}`];
// Inno Setup runs the sign tool for setup.exe and the uninstaller: $f is the file, $q a quote.
if (signCommand) isccArgs.push("/DSign", `/Szamtech=${signCommand.replaceAll('"', "$q").replaceAll("{file}", "$f")}`);
run(iscc, [...isccArgs, join(installerDir, "zamtech-agent.iss")]);
rmSync(toolsDir, { recursive: true, force: true });
console.log(`\nInstaller: ${join(outDir, `ZamTechAI-Agent-Setup-${version}.exe`)}`);
