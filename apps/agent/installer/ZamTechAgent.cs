// ZamTech AI Agent tray app.
//
// Keeps the bot agent (node.exe agent.mjs connect) running in the signed-in
// desktop session, where desktop automation can see and click windows. A
// Windows service cannot do that: services run in session 0, which has no
// desktop. Started at sign-in from the HKCU Run key written by the installer.
//
//   ZamTechAgent.exe                       start (or, if already running, open Settings)
//   ZamTechAgent.exe --settings            start and open Settings
//   ZamTechAgent.exe --quit [--now] [--wait SECONDS]
//       stop the running instance, letting a running job finish unless --now;
//       exits with 2 if it is still running after SECONDS (default 15)
//   ZamTechAgent.exe --protect-key         encrypt a plain "key" in agent.json (used by setup)
//
// While it runs, status.txt next to it says "busy" or "idle" so setup can tell
// whether a job would be interrupted.
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
  const string MutexName = @"Local\ZamTechAIAgent";
  public const string QuitEventName = @"Local\ZamTechAIAgent.Quit";
  public const string QuitNowEventName = @"Local\ZamTechAIAgent.QuitNow";
  public const string ShowEventName = @"Local\ZamTechAIAgent.Show";

  [STAThread]
  static int Main(string[] args) {
    string dir = AppDomain.CurrentDomain.BaseDirectory;
    if (Has(args, "--protect-key")) {
      try {
        var s = new AgentSettings(Path.Combine(dir, "agent.json"));
        s.Load();
        if (s.HasPlainKey) s.Save();
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
      Application.Run(new AgentTray(dir, Has(args, "--settings")));
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

/// agent.json, shared with the agent (see apps/agent/src/config.ts). The key is
/// kept encrypted for the current Windows user (DPAPI) as "keyProtected".
class AgentSettings {
  public string Server = "";
  public string Key = "";
  public string Name = "";
  /// agent.json still has the key in plain text, as setup writes it.
  public bool HasPlainKey;
  Dictionary<string, object> raw = new Dictionary<string, object>();
  readonly string path;
  // Must match KEY_ENTROPY in apps/agent/src/config.ts.
  static readonly byte[] Entropy = Encoding.UTF8.GetBytes("ZamTech AI Agent key");

  public AgentSettings(string path) { this.path = path; }

  public bool Complete { get { return Server.Length > 0 && Key.Length > 0; } }

  public void Load() {
    if (!File.Exists(path)) return;
    try {
      raw = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(File.ReadAllText(path, Encoding.UTF8)) ?? new Dictionary<string, object>();
    } catch {
      raw = new Dictionary<string, object>();
    }
    Server = Get("server");
    Name = Get("name");
    Key = Get("key");
    HasPlainKey = Key.Length > 0;
    if (!HasPlainKey && Get("keyProtected").Length > 0) {
      try {
        Key = Encoding.UTF8.GetString(ProtectedData.Unprotect(Convert.FromBase64String(Get("keyProtected")), Entropy, DataProtectionScope.CurrentUser));
      } catch {
        Key = ""; // saved by another Windows user, or damaged: ask for the key again
      }
    }
  }

  string Get(string name) {
    object v;
    return raw.TryGetValue(name, out v) && v != null ? v.ToString().Trim() : "";
  }

  public void Save() {
    raw["server"] = Server;
    raw["name"] = Name;
    raw.Remove("key");
    raw["keyProtected"] = Convert.ToBase64String(ProtectedData.Protect(Encoding.UTF8.GetBytes(Key), Entropy, DataProtectionScope.CurrentUser));
    File.WriteAllText(path, new JavaScriptSerializer().Serialize(raw), new UTF8Encoding(false));
    HasPlainKey = false;
  }
}

class AgentTray : ApplicationContext {
  /// How long a running job may take to finish when the agent is stopped (ZAMTEST_DRAIN_SECONDS).
  const int DrainSeconds = 600;

  readonly string dir, logDir, configPath, statusPath;
  readonly NotifyIcon tray;
  readonly ToolStripMenuItem statusItem;
  readonly Control ui = new Control();
  readonly System.Windows.Forms.Timer restartTimer = new System.Windows.Forms.Timer();
  readonly System.Windows.Forms.Timer killTimer = new System.Windows.Forms.Timer();
  readonly object logGate = new object();
  readonly IntPtr job;
  Process agent;
  DateTime agentStarted;
  int failures;
  bool quitting, announced, busy, stopping;
  Action afterStop;
  SettingsForm settingsForm;

  public AgentTray(string dir, bool openSettings) {
    this.dir = dir;
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
    tray.DoubleClick += delegate { ShowSettings(); };

    restartTimer.Tick += delegate { restartTimer.Stop(); StartAgent(); };
    killTimer.Tick += delegate {
      killTimer.Stop();
      Log("[tray] The agent did not stop in time; ending it");
      try { if (agent != null) agent.Kill(); } catch { }
    };
    // Setup and uninstall ask the running instance to stop through these events.
    Watch(Program.QuitEventName, delegate { StopAgent(false, Exit); });
    Watch(Program.QuitNowEventName, delegate { StopAgent(true, Exit); });
    Watch(Program.ShowEventName, ShowSettings);

    var settings = LoadSettings();
    if (settings.HasPlainKey) {
      try { settings.Save(); } catch (Exception ex) { Log("[tray] Cannot encrypt the agent key: " + ex.Message); }
    }
    WriteStatus();
    if (openSettings || !settings.Complete) ShowSettings();
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

  /* ---------------------------- agent process ---------------------------- */

  void StartAgent() {
    if (quitting || agent != null) return;
    var settings = LoadSettings();
    if (!settings.Complete) {
      SetStatus("Not set up - open Settings");
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
    // The key is handed over in memory, so the agent does not have to decrypt agent.json itself.
    psi.EnvironmentVariables["ZAMTEST_AGENT_KEY"] = settings.Key;
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
    if (agent == null) { then(); return; }
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
      if (line.Contains("Registered as")) {
        SetStatus("Connected");
        if (!announced) {
          announced = true;
          tray.ShowBalloonTip(4000, "ZamTech AI Agent", "Connected. This PC can now run jobs.", ToolTipIcon.Info);
        }
      }
      else if (line.Contains("Invalid agent key")) SetStatus("Wrong agent key - open Settings");
      else if (line.Contains("retrying in") || line.Contains("Orchestrator error")) SetStatus("Cannot reach the server - retrying");
      else if (line.Contains("] Running job")) SetStatus("Running a job");
      else if (line.Contains("] Job ")) SetStatus("Connected");
    });
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
    settingsForm = new SettingsForm(LoadSettings());
    settingsForm.FormClosed += delegate {
      bool saved = settingsForm.DialogResult == DialogResult.OK;
      settingsForm = null;
      if (saved) {
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
    try { File.Delete(statusPath); } catch { }
    tray.Visible = false;
    tray.Dispose();
    ExitThread();
  }
}

class SettingsForm : Form {
  readonly AgentSettings settings;
  readonly TextBox server = new TextBox(), key = new TextBox(), name = new TextBox();
  readonly CheckBox startAtSignIn = new CheckBox();
  readonly Label result = new Label();
  const string RunKey = @"Software\Microsoft\Windows\CurrentVersion\Run";
  const string RunValue = "ZamTech AI Agent";

  public SettingsForm(AgentSettings settings) {
    this.settings = settings;
    Text = "ZamTech AI Agent settings";
    Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath);
    FormBorderStyle = FormBorderStyle.FixedDialog;
    MaximizeBox = false;
    MinimizeBox = false;
    StartPosition = FormStartPosition.CenterScreen;
    AutoScaleMode = AutoScaleMode.Font;
    Font = SystemFonts.MessageBoxFont;
    ClientSize = new Size(460, 300);

    var layout = new TableLayoutPanel { Dock = DockStyle.Fill, Padding = new Padding(14), ColumnCount = 2, RowCount = 7 };
    layout.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
    layout.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
    Controls.Add(layout);

    var intro = new Label {
      Text = "Connect this PC to your ZamTech AI orchestrator. Ask your administrator for the agent key (ZAMTEST_AGENT_KEY in deploy/.env).",
      AutoSize = true, MaximumSize = new Size(430, 0), Margin = new Padding(0, 0, 0, 10),
    };
    layout.Controls.Add(intro, 0, 0);
    layout.SetColumnSpan(intro, 2);
    AddRow(layout, 1, "Server URL", server, settings.Server.Length > 0 ? settings.Server : "https://api.zamtechai.com");
    AddRow(layout, 2, "Agent key", key, settings.Key);
    key.UseSystemPasswordChar = true;
    AddRow(layout, 3, "Bot name", name, settings.Name.Length > 0 ? settings.Name : Environment.MachineName);

    startAtSignIn.Text = "Start the agent when I sign in to Windows";
    startAtSignIn.AutoSize = true;
    startAtSignIn.Checked = StartsAtSignIn();
    startAtSignIn.Margin = new Padding(0, 8, 0, 0);
    layout.Controls.Add(startAtSignIn, 1, 4);

    result.AutoSize = true;
    result.MaximumSize = new Size(330, 0);
    result.Margin = new Padding(0, 8, 0, 0);
    layout.Controls.Add(result, 1, 5);

    var buttons = new FlowLayoutPanel { FlowDirection = FlowDirection.RightToLeft, Dock = DockStyle.Fill, AutoSize = true, Margin = new Padding(0, 12, 0, 0) };
    var save = new Button { Text = "Save and connect", AutoSize = true };
    var cancel = new Button { Text = "Cancel", AutoSize = true, DialogResult = DialogResult.Cancel };
    var test = new Button { Text = "Test connection", AutoSize = true };
    save.Click += delegate { Save(); };
    test.Click += delegate { TestConnection(); };
    buttons.Controls.Add(save);
    buttons.Controls.Add(cancel);
    buttons.Controls.Add(test);
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

  bool Validate(out string error) {
    Uri uri;
    error = null;
    if (!Uri.TryCreate(ServerUrl, UriKind.Absolute, out uri) || (uri.Scheme != "https" && uri.Scheme != "http")) error = "Enter the server address, e.g. https://api.zamtechai.com";
    else if (key.Text.Trim().Length == 0) error = "Enter the agent key.";
    return error == null;
  }

  void ShowResult(string text, bool ok) {
    result.ForeColor = ok ? Color.DarkGreen : Color.Firebrick;
    result.Text = text;
  }

  void TestConnection() {
    string error;
    if (!Validate(out error)) { ShowResult(error, false); return; }
    ShowResult("Testing...", true);
    Cursor = Cursors.WaitCursor;
    string url = ServerUrl, agentKey = key.Text.Trim();
    ThreadPool.QueueUserWorkItem(delegate {
      string message;
      bool ok = Probe(url, agentKey, out message);
      BeginInvoke((Action)delegate { Cursor = Cursors.Default; ShowResult(message, ok); });
    });
  }

  /// Health check, then a heartbeat for an unknown agent: 401 means the key is wrong, any other answer means it is right.
  static bool Probe(string server, string agentKey, out string message) {
    ServicePointManager.SecurityProtocol |= (SecurityProtocolType)3072; // TLS 1.2
    try {
      var health = (HttpWebRequest)WebRequest.Create(server + "/api/health");
      health.Timeout = 10000;
      using (health.GetResponse()) { }
    } catch (Exception ex) {
      message = "Cannot reach " + server + ": " + ex.Message;
      return false;
    }
    try {
      var hb = (HttpWebRequest)WebRequest.Create(server + "/api/agent/heartbeat");
      hb.Method = "POST";
      hb.Timeout = 10000;
      hb.ContentType = "application/json";
      hb.Headers["x-agent-key"] = agentKey;
      byte[] body = Encoding.UTF8.GetBytes("{\"agentId\":\"connection-test\"}");
      using (var s = hb.GetRequestStream()) s.Write(body, 0, body.Length);
      using (hb.GetResponse()) { }
    } catch (WebException ex) {
      var res = ex.Response as HttpWebResponse;
      if (res == null) { message = "Cannot reach " + server + ": " + ex.Message; return false; }
      if (res.StatusCode == HttpStatusCode.Unauthorized) { message = "The server answered, but the agent key is wrong."; return false; }
    }
    message = "Connection works.";
    return true;
  }

  void Save() {
    string error;
    if (!Validate(out error)) { ShowResult(error, false); return; }
    settings.Server = ServerUrl;
    settings.Key = key.Text.Trim();
    settings.Name = name.Text.Trim();
    try {
      settings.Save();
      SetStartAtSignIn(startAtSignIn.Checked);
    } catch (Exception ex) {
      ShowResult("Cannot save the settings: " + ex.Message, false);
      return;
    }
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
