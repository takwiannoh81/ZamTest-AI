// ZamTech AI Agent tray app.
//
// Keeps the bot agent (node.exe agent.mjs connect) running in the signed-in
// desktop session, where desktop automation can see and click windows. A
// Windows service cannot do that: services run in session 0, which has no
// desktop. Started at sign-in from the HKCU Run key written by the installer.
//
// Connecting a PC needs no key: the tray app asks the orchestrator for an
// approval link and opens it in the Portal, where a signed-in Developer or
// Admin approves the PC. The PC then gets its own credential, kept encrypted
// for this Windows user (DPAPI). An install key (IT rollouts) approves at once.
//
//   ZamTechAgent.exe                       start (or, if already running, open Settings)
//   ZamTechAgent.exe --first-run           start after setup: approval, then the Designer
//   ZamTechAgent.exe --settings            start and open Settings
//   ZamTechAgent.exe --quit [--now] [--wait SECONDS]
//       stop the running instance, letting a running job finish unless --now;
//       exits with 2 if it is still running after SECONDS (default 15)
//
// Setup leaves its choices (server, bot name, install key) in setup.json,
// which is merged into agent.json on start. While running, status.txt says
// "busy" or "idle" so setup can tell whether a job would be interrupted.
//
// Built with the C# 5 compiler that ships with .NET Framework 4 (see
// scripts/build-installer.mjs), so no newer language features.

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Win32;

[assembly: System.Reflection.AssemblyTitle("ZamTech AI Agent")]
[assembly: System.Reflection.AssemblyProduct("ZamTech AI")]
[assembly: System.Reflection.AssemblyCompany("ZamTech AI")]

static class Program {
  // One running instance per install folder; setup stops the one in its own folder.
  static string MutexName;
  public static string QuitEventName, QuitNowEventName, ShowEventName;
  public const string Version = "0.3.3";

  static void NameInstance(string dir) {
    string id;
    using (var sha = SHA256.Create()) {
      byte[] hash = sha.ComputeHash(Encoding.UTF8.GetBytes(Path.GetFullPath(dir).TrimEnd('\\').ToLowerInvariant()));
      id = BitConverter.ToString(hash).Replace("-", "").Substring(0, 16);
    }
    MutexName = @"Local\ZamTechAIAgent." + id;
    QuitEventName = MutexName + ".Quit";
    QuitNowEventName = MutexName + ".QuitNow";
    ShowEventName = MutexName + ".Show";
  }

  [STAThread]
  static int Main(string[] args) {
    string dir = AppDomain.CurrentDomain.BaseDirectory;
    NameInstance(dir);
    if (Has(args, "--protect-key")) {
      // Older setups wrote secrets in plain text; encrypt them for this user.
      try {
        var s = new AgentSettings(Path.Combine(dir, "agent.json"));
        s.Load();
        if (s.HasPlainSecrets) s.Save();
        return 0;
      } catch {
        return 1;
      }
    }
    if (Has(args, "--quit")) {
      int wait = 15;
      int i = Array.IndexOf(args, "--wait");
      if (i >= 0 && i + 1 < args.Length) int.TryParse(args[i + 1], out wait);
      return QuitRunning(Has(args, "--now"), wait) ? 0 : 2;
    }

    bool created;
    var mutex = new Mutex(true, MutexName, out created);
    if (!created) {
      Signal(ShowEventName);
      return 0;
    }
    try {
      Application.EnableVisualStyles();
      Application.SetCompatibleTextRenderingDefault(false);
      Application.Run(new AgentTray(dir, Has(args, "--settings"), Has(args, "--first-run")));
    } finally {
      mutex.ReleaseMutex();
    }
    return 0;
  }

  static bool Has(string[] args, string flag) {
    return Array.IndexOf(args, flag) >= 0;
  }

  static void Signal(string name) {
    try {
      using (var e = EventWaitHandle.OpenExisting(name)) e.Set();
    } catch (WaitHandleCannotBeOpenedException) { }
  }

  /// Asks a running instance to stop and waits until it has.
  static bool QuitRunning(bool now, int waitSeconds) {
    Signal(now ? QuitNowEventName : QuitEventName);
    var until = DateTime.Now.AddSeconds(Math.Max(0, waitSeconds));
    do {
      bool created;
      using (var m = new Mutex(false, MutexName, out created)) {
        if (created) return true;
        try {
          if (m.WaitOne(0)) { m.ReleaseMutex(); return true; }
        } catch (AbandonedMutexException) { return true; }
      }
      Thread.Sleep(200);
    } while (DateTime.Now < until);
    return false;
  }
}

/// JSON over HTTP(S) to the orchestrator.
static class Http {
  public class Reply {
    public int Status;
    public Dictionary<string, object> Json;
    public bool Ok { get { return Status >= 200 && Status < 300; } }
    public string Error { get { string e = Str(Json, "error"); return e.Length > 0 ? e : "HTTP " + Status; } }
  }

  static Http() {
    ServicePointManager.SecurityProtocol |= (SecurityProtocolType)3072; // TLS 1.2
  }

  public static Reply Send(string method, string url, Dictionary<string, object> body) {
    var req = (HttpWebRequest)WebRequest.Create(url);
    req.Method = method;
    req.Timeout = 15000;
    req.Accept = "application/json";
    if (body != null) {
      req.ContentType = "application/json";
      byte[] data = Encoding.UTF8.GetBytes(new JavaScriptSerializer().Serialize(body));
      using (var s = req.GetRequestStream()) s.Write(data, 0, data.Length);
    }
    HttpWebResponse res;
    try {
      res = (HttpWebResponse)req.GetResponse();
    } catch (WebException ex) {
      res = ex.Response as HttpWebResponse;
      if (res == null) throw;
    }
    using (res)
    using (var reader = new StreamReader(res.GetResponseStream(), Encoding.UTF8)) {
      string text = reader.ReadToEnd();
      var reply = new Reply { Status = (int)res.StatusCode, Json = new Dictionary<string, object>() };
      try {
        if (text.Length > 0) reply.Json = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(text) ?? reply.Json;
      } catch { }
      return reply;
    }
  }

  public static string Str(Dictionary<string, object> d, string key) {
    object v;
    return d != null && d.TryGetValue(key, out v) && v != null ? v.ToString() : "";
  }
}

/// agent.json, shared with the agent (see apps/agent/src/config.ts). Secrets are
/// kept encrypted for the current Windows user (DPAPI): "tokenProtected" for the
/// PC's own credential, "keyProtected" for a shared agent key (older installs).
class AgentSettings {
  public string Server = "";
  public string Name = "";
  public string Token = "";
  public string AgentId = "";
  public string Key = "";
  public string InstallKey = "";
  public string PortalUrl = "";
  public string DesignerUrl = "";
  /// agent.json still holds a secret in plain text.
  public bool HasPlainSecrets;
  Dictionary<string, object> raw = new Dictionary<string, object>();
  readonly string path;
  // Must match KEY_ENTROPY in apps/agent/src/config.ts.
  static readonly byte[] Entropy = Encoding.UTF8.GetBytes("ZamTech AI Agent key");

  public AgentSettings(string path) { this.path = path; }

  /// Connected: this PC has its own credential (or a shared key) for a server.
  public bool Complete { get { return Server.Length > 0 && (Token.Length > 0 || Key.Length > 0); } }

  public void Load() {
    raw = Read(path);
    Server = Get("server");
    Name = Get("name");
    AgentId = Get("agentId");
    InstallKey = Get("installKey");
    PortalUrl = Get("portalUrl");
    DesignerUrl = Get("designerUrl");
    HasPlainSecrets = Get("token").Length > 0 || Get("key").Length > 0;
    Token = Reveal("token", "tokenProtected");
    Key = Reveal("key", "keyProtected");
  }

  static Dictionary<string, object> Read(string file) {
    if (!File.Exists(file)) return new Dictionary<string, object>();
    try {
      return new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(File.ReadAllText(file, Encoding.UTF8)) ?? new Dictionary<string, object>();
    } catch {
      return new Dictionary<string, object>();
    }
  }

  string Get(string name) {
    return Http.Str(raw, name).Trim();
  }

  string Reveal(string plainName, string protectedName) {
    string plain = Get(plainName);
    if (plain.Length > 0) return plain;
    string sealedValue = Get(protectedName);
    if (sealedValue.Length == 0) return "";
    try {
      return Encoding.UTF8.GetString(ProtectedData.Unprotect(Convert.FromBase64String(sealedValue), Entropy, DataProtectionScope.CurrentUser));
    } catch {
      return ""; // saved by another Windows user, or damaged: connect the PC again
    }
  }

  void Seal(string plainName, string protectedName, string value) {
    raw.Remove(plainName);
    if (value.Length == 0) raw.Remove(protectedName);
    else raw[protectedName] = Convert.ToBase64String(ProtectedData.Protect(Encoding.UTF8.GetBytes(value), Entropy, DataProtectionScope.CurrentUser));
  }

  void Put(string name, string value) {
    if (value.Length == 0) raw.Remove(name);
    else raw[name] = value;
  }

  public void Save() {
    Put("server", Server);
    Put("name", Name);
    Put("agentId", AgentId);
    Put("installKey", InstallKey);
    Put("portalUrl", PortalUrl);
    Put("designerUrl", DesignerUrl);
    Seal("token", "tokenProtected", Token);
    Seal("key", "keyProtected", Key);
    File.WriteAllText(path, new JavaScriptSerializer().Serialize(raw), new UTF8Encoding(false));
    HasPlainSecrets = false;
  }

  /// Takes over what setup chose (setup.json) and deletes that file. A new server
  /// means the PC has to be approved there, so its credential is dropped.
  public bool MergeSetup(string setupFile) {
    if (!File.Exists(setupFile)) return false;
    var setup = Read(setupFile);
    string server = Http.Str(setup, "server").Trim().TrimEnd('/');
    if (server.Length > 0 && !string.Equals(server, Server, StringComparison.OrdinalIgnoreCase)) {
      Server = server;
      Token = "";
      AgentId = "";
      PortalUrl = "";
      DesignerUrl = "";
    }
    string name = Http.Str(setup, "name").Trim();
    if (name.Length > 0) Name = name;
    string installKey = Http.Str(setup, "installKey").Trim();
    if (installKey.Length > 0) InstallKey = installKey;
    Save();
    try { File.Delete(setupFile); } catch { }
    return true;
  }
}

class AgentTray : ApplicationContext {
  /// How long a running job may take to finish when the agent is stopped (ZAMTEST_DRAIN_SECONDS).
  const int DrainSeconds = 600;

  readonly string dir, logDir, configPath, statusPath;
  readonly NotifyIcon tray;
  readonly ToolStripMenuItem statusItem, approveItem;
  readonly Control ui = new Control();
  readonly System.Windows.Forms.Timer restartTimer = new System.Windows.Forms.Timer();
  readonly System.Windows.Forms.Timer killTimer = new System.Windows.Forms.Timer();
  readonly System.Windows.Forms.Timer enrollRetryTimer = new System.Windows.Forms.Timer();
  readonly object logGate = new object();
  readonly IntPtr job;
  Process agent;
  DateTime agentStarted;
  int failures, enrollGeneration;
  bool quitting, announced, busy, stopping, enrolling, firstRun;
  string approvalUrl;
  Action afterStop;
  SettingsForm settingsForm;

  public AgentTray(string dir, bool openSettings, bool firstRun) {
    this.dir = dir;
    this.firstRun = firstRun;
    logDir = Path.Combine(dir, "logs");
    configPath = Path.Combine(dir, "agent.json");
    statusPath = Path.Combine(dir, "status.txt");
    Directory.CreateDirectory(logDir);
    CleanOldLogs();
    ui.CreateControl();
    job = Native.CreateKillOnCloseJob();

    var menu = new ContextMenuStrip();
    statusItem = new ToolStripMenuItem("Starting...") { Enabled = false };
    menu.Items.Add(statusItem);
    approveItem = new ToolStripMenuItem("Open the approval page", null, delegate { if (approvalUrl != null) OpenUrl(approvalUrl); }) { Visible = false };
    menu.Items.Add(approveItem);
    menu.Items.Add(new ToolStripSeparator());
    menu.Items.Add("Open Designer", null, delegate { OpenSite(true); });
    menu.Items.Add("Open Portal", null, delegate { OpenSite(false); });
    menu.Items.Add(new ToolStripSeparator());
    menu.Items.Add("Settings...", null, delegate { ShowSettings(); });
    menu.Items.Add("Open log", null, delegate { OpenLog(); });
    menu.Items.Add("Run desktop self-test", null, delegate { RunInConsole("desktop-test", "Desktop self-test"); });
    menu.Items.Add("Record a desktop workflow...", null, delegate { RunInConsole("record-desktop --upload --config \"" + configPath + "\"", "Record a desktop workflow"); });
    menu.Items.Add(new ToolStripSeparator());
    menu.Items.Add("Restart agent", null, delegate { AskAndStop("restart", delegate { failures = 0; StartAgent(); }); });
    menu.Items.Add("Quit", null, delegate { AskAndStop("quit", Exit); });

    tray = new NotifyIcon {
      Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath),
      Text = "ZamTech AI Agent",
      ContextMenuStrip = menu,
      Visible = true,
    };
    tray.DoubleClick += delegate { if (enrolling && approvalUrl != null) OpenUrl(approvalUrl); else ShowSettings(); };
    tray.BalloonTipClicked += delegate { if (enrolling && approvalUrl != null) OpenUrl(approvalUrl); };

    restartTimer.Tick += delegate { restartTimer.Stop(); StartAgent(); };
    killTimer.Tick += delegate {
      killTimer.Stop();
      Log("[tray] The agent did not stop in time; ending it");
      try { if (agent != null) agent.Kill(); } catch { }
    };
    enrollRetryTimer.Interval = 30000;
    enrollRetryTimer.Tick += delegate { enrollRetryTimer.Stop(); StartAgent(); };
    // Setup and uninstall ask the running instance to stop through these events.
    Watch(Program.QuitEventName, delegate { StopAgent(false, Exit); });
    Watch(Program.QuitNowEventName, delegate { StopAgent(true, Exit); });
    Watch(Program.ShowEventName, ShowSettings);

    var settings = LoadSettings();
    try {
      if (settings.MergeSetup(Path.Combine(dir, "setup.json"))) Log("[tray] Applied the choices made in setup");
      else if (settings.HasPlainSecrets) settings.Save();
    } catch (Exception ex) {
      Log("[tray] Cannot update agent.json: " + ex.Message);
    }
    WriteStatus();
    if (openSettings || settings.Server.Length == 0) ShowSettings();
    // Just installed on a PC that is already connected (an upgrade): open the Designer right away.
    if (firstRun && settings.Complete) {
      this.firstRun = false;
      OpenSite(true);
    }
    StartAgent();
  }

  AgentSettings LoadSettings() {
    var s = new AgentSettings(configPath);
    s.Load();
    return s;
  }

  void Watch(string name, Action action) {
    var handle = new EventWaitHandle(false, EventResetMode.AutoReset, name);
    ThreadPool.RegisterWaitForSingleObject(handle, delegate { OnUi(action); }, null, -1, false);
  }

  void OnUi(Action action) {
    if (ui.IsHandleCreated) ui.BeginInvoke(action);
  }

  void SetStatus(string status) {
    statusItem.Text = status;
    string tip = "ZamTech AI Agent: " + status;
    tray.Text = tip.Length > 63 ? tip.Substring(0, 63) : tip;
  }

  void WriteStatus() {
    try { File.WriteAllText(statusPath, busy ? "busy" : "idle"); } catch { }
  }

  static void OpenUrl(string url) {
    try { Process.Start(new ProcessStartInfo(url) { UseShellExecute = true }); } catch { }
  }

  /// Opens the Designer or the Portal, asking the server where they are if needed.
  void OpenSite(bool designer) {
    var s = LoadSettings();
    string known = designer ? s.DesignerUrl : s.PortalUrl;
    if (known.Length > 0) { OpenUrl(known); return; }
    string server = s.Server;
    ThreadPool.QueueUserWorkItem(delegate {
      string url = "";
      try {
        var health = Http.Send("GET", server + "/api/health", null);
        url = Http.Str(health.Json, designer ? "designerUrl" : "portalUrl");
        if (url.Length > 0) {
          OnUi(delegate {
            var fresh = LoadSettings();
            fresh.PortalUrl = Http.Str(health.Json, "portalUrl");
            fresh.DesignerUrl = Http.Str(health.Json, "designerUrl");
            try { fresh.Save(); } catch { }
          });
        }
      } catch { }
      // Fall back to the usual layout: api.example.com -> designer.example.com / portal.example.com.
      if (url.Length == 0 && server.Contains("://api.")) url = server.Replace("://api.", designer ? "://designer." : "://portal.");
      if (url.Length > 0) OpenUrl(url);
    });
  }

  /* ---------------------------- agent process ---------------------------- */

  void StartAgent() {
    if (quitting || agent != null || enrolling) return;
    var settings = LoadSettings();
    if (settings.Server.Length == 0) {
      SetStatus("Not set up - open Settings");
      return;
    }
    if (!settings.Complete) {
      BeginEnrollment();
      return;
    }
    var psi = new ProcessStartInfo(Path.Combine(dir, "node.exe"), "\"" + Path.Combine(dir, "agent.mjs") + "\" connect --config \"" + configPath + "\"") {
      WorkingDirectory = dir,
      UseShellExecute = false,
      CreateNoWindow = true,
      RedirectStandardInput = true,
      RedirectStandardOutput = true,
      RedirectStandardError = true,
      StandardOutputEncoding = Encoding.UTF8,
      StandardErrorEncoding = Encoding.UTF8,
    };
    // The credential is handed over in memory, so the agent does not have to decrypt agent.json itself.
    psi.EnvironmentVariables.Remove("ZAMTEST_AGENT_TOKEN");
    psi.EnvironmentVariables.Remove("ZAMTEST_AGENT_KEY");
    if (settings.Token.Length > 0) psi.EnvironmentVariables["ZAMTEST_AGENT_TOKEN"] = settings.Token;
    else psi.EnvironmentVariables["ZAMTEST_AGENT_KEY"] = settings.Key;
    psi.EnvironmentVariables["ZAMTEST_STDIN_CONTROL"] = "1";
    psi.EnvironmentVariables["ZAMTEST_DRAIN_SECONDS"] = DrainSeconds.ToString();
    psi.EnvironmentVariables["NO_COLOR"] = "1";
    var p = new Process { StartInfo = psi, EnableRaisingEvents = true };
    p.OutputDataReceived += delegate(object s, DataReceivedEventArgs e) { OnLine(e.Data); };
    p.ErrorDataReceived += delegate(object s, DataReceivedEventArgs e) { OnLine(e.Data); };
    p.Exited += delegate { OnUi(delegate { OnExited(p); }); };
    try {
      p.Start();
    } catch (Exception ex) {
      Log("[tray] Cannot start the agent: " + ex.Message);
      SetStatus("Cannot start - see log");
      return;
    }
    if (job != IntPtr.Zero) Native.AssignProcessToJobObject(job, p.Handle);
    p.BeginOutputReadLine();
    p.BeginErrorReadLine();
    agent = p;
    agentStarted = DateTime.Now;
    Log("[tray] Agent started (pid " + p.Id + ")");
    SetStatus("Connecting to " + settings.Server);
  }

  /// Restart/Quit from the menu: asks first when that would interrupt a job.
  void AskAndStop(string what, Action then) {
    if (agent == null) { CancelEnrollment(); then(); return; }
    if (!busy) { StopAgent(false, then); return; }
    if (stopping) {
      var cancel = MessageBox.Show("The agent is waiting for the current job to finish. Cancel the job and " + what + " now?",
        "ZamTech AI Agent", MessageBoxButtons.YesNo, MessageBoxIcon.Warning);
      if (cancel == DialogResult.Yes) StopAgent(true, then);
      return;
    }
    var answer = MessageBox.Show(
      "A job is running on this PC.\n\nYes: let it finish, then " + what + " (waits up to " + (DrainSeconds / 60) + " minutes).\nNo: cancel the job and " + what + " now.",
      "ZamTech AI Agent", MessageBoxButtons.YesNoCancel, MessageBoxIcon.Question);
    if (answer == DialogResult.Yes) StopAgent(false, then);
    else if (answer == DialogResult.No) StopAgent(true, then);
  }

  /// Asks the agent to stop (after its job, or at once) and runs `then` once it has exited.
  void StopAgent(bool now, Action then) {
    restartTimer.Stop();
    if (then != null) afterStop = then;
    var p = agent;
    if (p == null) {
      RunAfterStop();
      return;
    }
    stopping = true;
    try {
      p.StandardInput.WriteLine(now ? "stop" : "drain");
      p.StandardInput.Flush();
    } catch { }
    SetStatus(busy && !now ? "Finishing the current job, then stopping" : "Stopping");
    killTimer.Stop();
    killTimer.Interval = (now || !busy ? 30 : DrainSeconds + 60) * 1000;
    killTimer.Start();
  }

  void RunAfterStop() {
    var a = afterStop;
    afterStop = null;
    if (a != null) a();
  }

  void OnExited(Process p) {
    if (agent != p) return;
    agent = null;
    busy = false;
    WriteStatus();
    killTimer.Stop();
    int code = -1;
    try { code = p.ExitCode; } catch { }
    Log("[tray] Agent exited with code " + code);
    if (stopping) {
      stopping = false;
      SetStatus("Stopped");
      RunAfterStop();
      return;
    }
    if (quitting) return;
    if ((DateTime.Now - agentStarted).TotalSeconds > 120) failures = 0;
    failures++;
    int[] delays = { 2, 5, 10, 30, 60 };
    int delay = delays[Math.Min(failures - 1, delays.Length - 1)];
    SetStatus("Stopped - restarting in " + delay + " s");
    restartTimer.Interval = delay * 1000;
    restartTimer.Start();
  }

  void OnLine(string line) {
    if (line == null) return;
    Log(line);
    OnUi(delegate {
      if (line.Contains("] Running job")) { busy = true; WriteStatus(); }
      else if (line.Contains("] Job ")) { busy = false; WriteStatus(); }
      if (stopping) {
        if (line.Contains("] Job ")) SetStatus("Stopping");
        return;
      }
      if (line.Contains("no longer approved")) {
        PcRemoved();
        return;
      }
      if (line.Contains("Registered as")) {
        SetStatus("Connected");
        if (!announced) {
          announced = true;
          tray.ShowBalloonTip(4000, "ZamTech AI Agent", "Connected. This PC can now run jobs.", ToolTipIcon.Info);
        }
      }
      else if (line.Contains("Invalid agent key")) SetStatus("Not approved - use Settings > Connect this PC");
      else if (line.Contains("retrying in") || line.Contains("Orchestrator error")) SetStatus("Cannot reach the server - retrying");
      else if (line.Contains("] Running job")) SetStatus("Running a job");
      else if (line.Contains("] Job ")) SetStatus("Connected");
    });
  }

  /// The PC was removed in the Portal: its credential no longer works, so ask for approval again.
  void PcRemoved() {
    Log("[tray] This PC was removed in the Portal; asking for approval again");
    var s = LoadSettings();
    s.Token = "";
    s.AgentId = "";
    try { s.Save(); } catch { }
    StopAgent(true, StartAgent);
  }

  /* ------------------------- connecting this PC -------------------------- */

  void BeginEnrollment() {
    if (quitting || enrolling) return;
    enrollRetryTimer.Stop();
    enrolling = true;
    int generation = ++enrollGeneration;
    var s = LoadSettings();
    string name = s.Name.Length > 0 ? s.Name : Environment.MachineName;
    SetStatus("Connecting this PC...");
    new Thread(delegate() { Enroll(generation, s.Server, name, s.InstallKey); }) { IsBackground = true }.Start();
  }

  void CancelEnrollment() {
    enrollGeneration++;
    enrolling = false;
    approveItem.Visible = false;
    enrollRetryTimer.Stop();
  }

  bool Current(int generation) {
    return generation == enrollGeneration && !quitting;
  }

  /// Runs on a background thread: start, show the approval page, then wait for the decision.
  void Enroll(int generation, string server, string name, string installKey) {
    try {
      var body = new Dictionary<string, object> {
        { "name", name },
        { "machine", Environment.MachineName },
        { "os", "win32 " + Environment.OSVersion.Version },
        { "version", Program.Version },
      };
      if (installKey.Length > 0) body["installKey"] = installKey;
      var start = Http.Send("POST", server + "/api/agent/enroll/start", body);
      if (start.Status == 401 && installKey.Length > 0) {
        Log("[tray] The install key was not accepted (" + start.Error + "); asking for approval in the browser instead");
        OnUi(delegate { var s = LoadSettings(); s.InstallKey = ""; try { s.Save(); } catch { } });
        body.Remove("installKey");
        start = Http.Send("POST", server + "/api/agent/enroll/start", body);
      }
      if (!start.Ok) throw new Exception(start.Error);
      string deviceCode = Http.Str(start.Json, "deviceCode");
      string url = Http.Str(start.Json, "verificationUrl") + (firstRun ? "&next=designer" : "");
      bool approvedAtOnce = Http.Str(start.Json, "approved") == "True";
      int interval = Math.Max(2, Convert.ToInt32(start.Json.ContainsKey("interval") ? start.Json["interval"] : 3));
      int expiresIn = Convert.ToInt32(start.Json.ContainsKey("expiresIn") ? start.Json["expiresIn"] : 900);
      if (!approvedAtOnce) {
        // The Portal shows the same code, so the person can check they approve this PC.
        string code = Http.Str(start.Json, "userCode");
        Log("[tray] Waiting for approval in the Portal (code " + code + ")");
        OnUi(delegate {
          if (!Current(generation)) return;
          approvalUrl = url;
          approveItem.Visible = true;
          SetStatus("Waiting for approval - code " + code);
          OpenUrl(url);
          tray.ShowBalloonTip(10000, "Approve this PC: code " + code,
            "Approve this PC in the ZamTech AI Portal in your browser, checking that it shows code " + code + ". Click here to open the page again.", ToolTipIcon.Info);
        });
      }
      var until = DateTime.Now.AddSeconds(expiresIn);
      while (DateTime.Now < until && Current(generation)) {
        var poll = Http.Send("POST", server + "/api/agent/enroll/poll", new Dictionary<string, object> { { "deviceCode", deviceCode } });
        string status = Http.Str(poll.Json, "status");
        if (status == "approved") {
          var result = poll.Json;
          OnUi(delegate { if (Current(generation)) FinishEnrollment(result); });
          return;
        }
        if (status == "denied") {
          OnUi(delegate { if (Current(generation)) EnrollmentEnded("Declined in the Portal - use Settings > Connect this PC"); });
          return;
        }
        if (status == "expired") break;
        Thread.Sleep(interval * 1000);
      }
      OnUi(delegate { if (Current(generation)) EnrollmentEnded("Not connected - use Settings > Connect this PC"); });
    } catch (Exception ex) {
      Log("[tray] Cannot connect this PC: " + ex.Message);
      OnUi(delegate {
        if (!Current(generation)) return;
        enrolling = false;
        approveItem.Visible = false;
        SetStatus("Cannot reach the server - retrying");
        enrollRetryTimer.Start();
      });
    }
  }

  void FinishEnrollment(Dictionary<string, object> result) {
    // Approved in the browser: the Portal continues into the Designer by itself.
    bool approvedInBrowser = approvalUrl != null;
    enrolling = false;
    approveItem.Visible = false;
    approvalUrl = null;
    var s = LoadSettings();
    s.Token = Http.Str(result, "agentToken");
    s.AgentId = Http.Str(result, "agentId");
    s.InstallKey = "";
    if (Http.Str(result, "name").Length > 0) s.Name = Http.Str(result, "name");
    if (Http.Str(result, "portalUrl").Length > 0) s.PortalUrl = Http.Str(result, "portalUrl");
    if (Http.Str(result, "designerUrl").Length > 0) s.DesignerUrl = Http.Str(result, "designerUrl");
    try {
      s.Save();
    } catch (Exception ex) {
      Log("[tray] Cannot save the credential: " + ex.Message);
      SetStatus("Cannot save the settings - see log");
      return;
    }
    Log("[tray] This PC was approved by " + Http.Str(result, "approvedBy"));
    // An install key approves without the browser, so open the Designer here after a fresh install.
    if (firstRun) {
      firstRun = false;
      // signin=1: the person signs in, not whoever was signed in in that browser.
      if (s.DesignerUrl.Length > 0 && !approvedInBrowser) OpenUrl(s.DesignerUrl + (s.DesignerUrl.Contains("?") ? "&" : "?") + "signin=1");
    }
    announced = false;
    StartAgent();
  }

  void EnrollmentEnded(string status) {
    enrolling = false;
    approveItem.Visible = false;
    approvalUrl = null;
    firstRun = false;
    SetStatus(status);
  }

  /// Settings > Connect this PC: forget the credential and ask for approval again.
  void Reconnect() {
    var s = LoadSettings();
    s.Token = "";
    s.AgentId = "";
    s.Key = "";
    try { s.Save(); } catch { }
    CancelEnrollment();
    announced = false;
    failures = 0;
    StopAgent(false, StartAgent);
  }

  /* --------------------------------- logs -------------------------------- */

  string LogFile { get { return Path.Combine(logDir, "agent-" + DateTime.Now.ToString("yyyy-MM-dd") + ".log"); } }

  void Log(string line) {
    lock (logGate) {
      try {
        File.AppendAllText(LogFile, DateTime.Now.ToString("HH:mm:ss ") + line + Environment.NewLine, Encoding.UTF8);
      } catch { }
    }
  }

  void CleanOldLogs() {
    try {
      foreach (var f in Directory.GetFiles(logDir, "agent-*.log")) {
        if (File.GetLastWriteTime(f) < DateTime.Now.AddDays(-14)) File.Delete(f);
      }
    } catch { }
  }

  void OpenLog() {
    if (!File.Exists(LogFile)) Log("[tray] Log opened");
    Process.Start("notepad.exe", "\"" + LogFile + "\"");
  }

  /// Runs an agent command in a visible console, e.g. the desktop self-test.
  void RunInConsole(string arguments, string title) {
    string command = "title " + title + " & \"" + Path.Combine(dir, "node.exe") + "\" \"" + Path.Combine(dir, "agent.mjs") + "\" " + arguments + " & echo. & pause";
    Process.Start(new ProcessStartInfo("cmd.exe", "/s /c \"" + command + "\"") { WorkingDirectory = logDir, UseShellExecute = false });
  }

  /* ------------------------------- settings ------------------------------ */

  void ShowSettings() {
    if (settingsForm != null) {
      settingsForm.Activate();
      return;
    }
    settingsForm = new SettingsForm(LoadSettings(), enrolling);
    settingsForm.FormClosed += delegate {
      var form = settingsForm;
      settingsForm = null;
      if (form.DialogResult != DialogResult.OK) return;
      if (form.ReconnectRequested) Reconnect();
      else {
        announced = false;
        StopAgent(false, delegate { failures = 0; StartAgent(); });
      }
    };
    settingsForm.Show();
    settingsForm.Activate();
  }

  void Exit() {
    if (quitting) return;
    quitting = true;
    CancelEnrollment();
    try { File.Delete(statusPath); } catch { }
    tray.Visible = false;
    tray.Dispose();
    ExitThread();
  }
}

class SettingsForm : Form {
  readonly AgentSettings settings;
  readonly TextBox server = new TextBox(), name = new TextBox();
  readonly CheckBox startAtSignIn = new CheckBox();
  readonly Label connection = new Label(), result = new Label();
  const string RunKey = @"Software\Microsoft\Windows\CurrentVersion\Run";
  const string RunValue = "ZamTech AI Agent";

  /// Save with a new server, or "Connect this PC again": ask for approval again.
  public bool ReconnectRequested;

  public SettingsForm(AgentSettings settings, bool waitingForApproval) {
    this.settings = settings;
    Text = "ZamTech AI Agent settings";
    Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath);
    FormBorderStyle = FormBorderStyle.FixedDialog;
    MaximizeBox = false;
    MinimizeBox = false;
    StartPosition = FormStartPosition.CenterScreen;
    AutoScaleMode = AutoScaleMode.Font;
    Font = SystemFonts.MessageBoxFont;
    ClientSize = new Size(480, 300);

    var layout = new TableLayoutPanel { Dock = DockStyle.Fill, Padding = new Padding(14), ColumnCount = 2, RowCount = 7 };
    layout.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
    layout.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
    Controls.Add(layout);

    var intro = new Label {
      Text = "This PC runs automations for your ZamTech AI workspace. A Developer or Admin approves it once in the Portal; no key is needed.",
      AutoSize = true, MaximumSize = new Size(450, 0), Margin = new Padding(0, 0, 0, 10),
    };
    layout.Controls.Add(intro, 0, 0);
    layout.SetColumnSpan(intro, 2);
    AddRow(layout, 1, "Server URL", server, settings.Server.Length > 0 ? settings.Server : "https://api.zamtechai.com");
    AddRow(layout, 2, "Bot name", name, settings.Name.Length > 0 ? settings.Name : Environment.MachineName);

    layout.Controls.Add(new Label { Text = "Status", AutoSize = true, Anchor = AnchorStyles.Left, Margin = new Padding(0, 8, 10, 0) }, 0, 3);
    connection.AutoSize = true;
    connection.MaximumSize = new Size(350, 0);
    connection.Margin = new Padding(0, 8, 0, 0);
    connection.Text = settings.Token.Length > 0
      ? "Connected" + (settings.AgentId.Length > 0 ? " (" + settings.AgentId + ")" : "")
      : settings.Key.Length > 0 ? "Connected with a shared agent key" : waitingForApproval ? "Waiting for approval in the Portal" : "Not connected";
    layout.Controls.Add(connection, 1, 3);

    startAtSignIn.Text = "Start the agent when I sign in to Windows";
    startAtSignIn.AutoSize = true;
    startAtSignIn.Checked = StartsAtSignIn();
    startAtSignIn.Margin = new Padding(0, 8, 0, 0);
    layout.Controls.Add(startAtSignIn, 1, 4);

    result.AutoSize = true;
    result.MaximumSize = new Size(350, 0);
    result.Margin = new Padding(0, 8, 0, 0);
    layout.Controls.Add(result, 1, 5);

    var buttons = new FlowLayoutPanel { FlowDirection = FlowDirection.RightToLeft, Dock = DockStyle.Fill, AutoSize = true, Margin = new Padding(0, 12, 0, 0) };
    var save = new Button { Text = "Save", AutoSize = true };
    var cancel = new Button { Text = "Cancel", AutoSize = true, DialogResult = DialogResult.Cancel };
    var test = new Button { Text = "Test connection", AutoSize = true };
    var reconnect = new Button { Text = "Connect this PC again", AutoSize = true };
    save.Click += delegate { Save(false); };
    test.Click += delegate { TestConnection(); };
    reconnect.Click += delegate {
      var sure = MessageBox.Show("This PC will stop running jobs until it is approved again in the Portal. Continue?",
        "ZamTech AI Agent", MessageBoxButtons.OKCancel, MessageBoxIcon.Question);
      if (sure == DialogResult.OK) Save(true);
    };
    buttons.Controls.Add(save);
    buttons.Controls.Add(cancel);
    buttons.Controls.Add(test);
    buttons.Controls.Add(reconnect);
    layout.Controls.Add(buttons, 0, 6);
    layout.SetColumnSpan(buttons, 2);
    AcceptButton = save;
    CancelButton = cancel;
  }

  static void AddRow(TableLayoutPanel layout, int row, string label, TextBox box, string value) {
    layout.Controls.Add(new Label { Text = label, AutoSize = true, Anchor = AnchorStyles.Left, Margin = new Padding(0, 6, 10, 0) }, 0, row);
    box.Text = value;
    box.Dock = DockStyle.Fill;
    layout.Controls.Add(box, 1, row);
  }

  string ServerUrl { get { return server.Text.Trim().TrimEnd('/'); } }

  bool ValidServer() {
    Uri uri;
    if (Uri.TryCreate(ServerUrl, UriKind.Absolute, out uri) && (uri.Scheme == "https" || uri.Scheme == "http")) return true;
    ShowResult("Enter the server address, e.g. https://api.zamtechai.com", false);
    return false;
  }

  void ShowResult(string text, bool ok) {
    result.ForeColor = ok ? Color.DarkGreen : Color.Firebrick;
    result.Text = text;
  }

  void TestConnection() {
    if (!ValidServer()) return;
    ShowResult("Testing...", true);
    Cursor = Cursors.WaitCursor;
    string url = ServerUrl;
    ThreadPool.QueueUserWorkItem(delegate {
      string message;
      bool ok;
      try {
        var health = Http.Send("GET", url + "/api/health", null);
        ok = health.Ok;
        message = ok ? "The server answers." : "The server answered with " + health.Error;
      } catch (Exception ex) {
        ok = false;
        message = "Cannot reach " + url + ": " + ex.Message;
      }
      BeginInvoke((Action)delegate { Cursor = Cursors.Default; ShowResult(message, ok); });
    });
  }

  void Save(bool reconnect) {
    if (!ValidServer()) return;
    bool newServer = !string.Equals(ServerUrl, settings.Server, StringComparison.OrdinalIgnoreCase);
    settings.Server = ServerUrl;
    settings.Name = name.Text.Trim();
    if (newServer) {
      // The credential belongs to the old server.
      settings.Token = "";
      settings.AgentId = "";
      settings.Key = "";
      settings.PortalUrl = "";
      settings.DesignerUrl = "";
    }
    try {
      settings.Save();
      SetStartAtSignIn(startAtSignIn.Checked);
    } catch (Exception ex) {
      ShowResult("Cannot save the settings: " + ex.Message, false);
      return;
    }
    ReconnectRequested = reconnect || newServer;
    DialogResult = DialogResult.OK;
    Close();
  }

  static bool StartsAtSignIn() {
    using (var k = Registry.CurrentUser.OpenSubKey(RunKey)) return k != null && k.GetValue(RunValue) != null;
  }

  static void SetStartAtSignIn(bool on) {
    using (var k = Registry.CurrentUser.CreateSubKey(RunKey)) {
      if (on) k.SetValue(RunValue, "\"" + Application.ExecutablePath + "\"");
      else if (k.GetValue(RunValue) != null) k.DeleteValue(RunValue);
    }
  }
}

/// A job object that kills node.exe if the tray app ends without stopping it.
static class Native {
  [StructLayout(LayoutKind.Sequential)]
  struct BasicLimit {
    public long PerProcessUserTimeLimit, PerJobUserTimeLimit;
    public uint LimitFlags;
    public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
    public uint ActiveProcessLimit;
    public UIntPtr Affinity;
    public uint PriorityClass, SchedulingClass;
  }

  [StructLayout(LayoutKind.Sequential)]
  struct IoCounters {
    public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount, ReadTransferCount, WriteTransferCount, OtherTransferCount;
  }

  [StructLayout(LayoutKind.Sequential)]
  struct ExtendedLimit {
    public BasicLimit Basic;
    public IoCounters Io;
    public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
  }

  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern IntPtr CreateJobObject(IntPtr attributes, string name);
  [DllImport("kernel32.dll")] static extern bool SetInformationJobObject(IntPtr job, int infoClass, IntPtr info, uint length);
  [DllImport("kernel32.dll")] public static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

  public static IntPtr CreateKillOnCloseJob() {
    IntPtr job = CreateJobObject(IntPtr.Zero, null);
    if (job == IntPtr.Zero) return IntPtr.Zero;
    var info = new ExtendedLimit();
    info.Basic.LimitFlags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
    int size = Marshal.SizeOf(typeof(ExtendedLimit));
    IntPtr ptr = Marshal.AllocHGlobal(size);
    try {
      Marshal.StructureToPtr(info, ptr, false);
      if (!SetInformationJobObject(job, 9, ptr, (uint)size)) return IntPtr.Zero; // JobObjectExtendedLimitInformation
    } finally {
      Marshal.FreeHGlobal(ptr);
    }
    return job;
  }
}
