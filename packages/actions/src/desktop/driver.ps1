# ZamTech AI desktop driver.
#
# Drives Windows applications through Microsoft UI Automation (built into
# Windows 10/11, no installation needed). The bot agent starts this script
# with Windows PowerShell and talks to it over stdin/stdout, one JSON
# message per line:
#   request:  {"id": 1, "op": "click", "args": {...}}
#   response: {"id": 1, "ok": true, "result": ...} or {"id": 1, "ok": false, "error": "..."}
#
# Selectors arrive already parsed (see selector.ts): a list of segments
#   { type: "button", conditions: [{ attr: "name", op: "=", value: "Save" }], index: 1 }

$ErrorActionPreference = 'Stop'
try {
  [Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
  [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
} catch { }

$script:UiaReady = $false
$script:ProcessNames = @{}
$script:ControlTypes = @{}

# JSON writer in C#: PowerShell's serializers trip over PSObject-wrapped values
# (e.g. hashtables added to lists) in Windows PowerShell 5.1. Needs no UI
# Automation, so it is compiled at startup on any OS.
$JsonSource = @'
using System;
using System.Collections;
using System.Globalization;
using System.Management.Automation;
using System.Text;

public static class ZtJson {
  public static string Write(object value) {
    var sb = new StringBuilder();
    Append(sb, value, 0);
    return sb.ToString();
  }

  static void Append(StringBuilder sb, object o, int depth) {
    var ps = o as PSObject;
    if (ps != null) {
      if (ps.BaseObject is PSCustomObject) {
        sb.Append('{');
        bool firstProp = true;
        foreach (var p in ps.Properties) {
          if (!firstProp) sb.Append(',');
          firstProp = false;
          Str(sb, p.Name);
          sb.Append(':');
          object v = null;
          try { v = p.Value; } catch { }
          Append(sb, v, depth + 1);
        }
        sb.Append('}');
        return;
      }
      o = ps.BaseObject;
    }
    if (o == null || depth > 40) { sb.Append("null"); return; }
    if (o is string || o is char) { Str(sb, o.ToString()); return; }
    if (o is bool) { sb.Append((bool)o ? "true" : "false"); return; }
    if (o is int || o is long || o is short || o is byte || o is uint || o is ulong || o is ushort || o is sbyte) {
      sb.Append(Convert.ToString(o, CultureInfo.InvariantCulture));
      return;
    }
    if (o is double || o is float || o is decimal) {
      double d = Convert.ToDouble(o, CultureInfo.InvariantCulture);
      if (double.IsNaN(d) || double.IsInfinity(d)) sb.Append("null");
      else sb.Append(d.ToString("R", CultureInfo.InvariantCulture));
      return;
    }
    var dict = o as IDictionary;
    if (dict != null) {
      sb.Append('{');
      bool first = true;
      foreach (DictionaryEntry e in dict) {
        if (!first) sb.Append(',');
        first = false;
        Str(sb, Convert.ToString(e.Key, CultureInfo.InvariantCulture));
        sb.Append(':');
        Append(sb, e.Value, depth + 1);
      }
      sb.Append('}');
      return;
    }
    var list = o as IEnumerable;
    if (list != null) {
      sb.Append('[');
      bool first = true;
      foreach (var item in list) {
        if (!first) sb.Append(',');
        first = false;
        Append(sb, item, depth + 1);
      }
      sb.Append(']');
      return;
    }
    Str(sb, Convert.ToString(o, CultureInfo.InvariantCulture));
  }

  static void Str(StringBuilder sb, string s) {
    sb.Append('"');
    foreach (char ch in s ?? "") {
      switch (ch) {
        case '"': sb.Append("\\\""); break;
        case '\\': sb.Append("\\\\"); break;
        case '\n': sb.Append("\\n"); break;
        case '\r': sb.Append("\\r"); break;
        case '\t': sb.Append("\\t"); break;
        default:
          if (ch < 0x20) sb.Append("\\u" + ((int)ch).ToString("x4")); else sb.Append(ch);
          break;
      }
    }
    sb.Append('"');
  }
}
'@
Add-Type -TypeDefinition $JsonSource -Language CSharp

$NativeSource = @'
using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Automation;

public static class ZtNative {
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hwnd, uint msg, IntPtr w, IntPtr l);

  public static void Init() { try { SetProcessDPIAware(); } catch { } }

  public static void Click(int x, int y, bool right, bool twice) {
    SetCursorPos(x, y);
    Thread.Sleep(40);
    uint down = right ? 0x0008u : 0x0002u, up = right ? 0x0010u : 0x0004u;
    for (int i = 0; i < (twice ? 2 : 1); i++) {
      mouse_event(down, 0, 0, 0, UIntPtr.Zero);
      mouse_event(up, 0, 0, 0, UIntPtr.Zero);
      Thread.Sleep(60);
    }
  }
}

/// Control type names as used in selectors. Classic Win32 and WinForms controls that
/// UI Automation only exposes as "pane" get their real type from the window class.
public static class ZtTypes {
  static readonly Dictionary<string, string> Win32 = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase) {
    { "Edit", "edit" }, { "Button", "button" }, { "ComboBox", "combobox" }, { "ComboBoxEx32", "combobox" },
    { "ListBox", "list" }, { "SysListView32", "list" }, { "SysTreeView32", "tree" }, { "Static", "text" },
    { "msctls_statusbar32", "statusbar" }, { "SysTabControl32", "tab" }, { "ToolbarWindow32", "toolbar" },
    { "msctls_progress32", "progressbar" }, { "msctls_trackbar32", "slider" }, { "SysLink", "hyperlink" },
    { "SysHeader32", "header" }, { "ScrollBar", "scrollbar" }, { "#32770", "window" }
  };

  public static string FromClass(string cls) {
    if (string.IsNullOrEmpty(cls)) return null;
    string mapped;
    if (Win32.TryGetValue(cls, out mapped)) return mapped;
    if (cls.StartsWith("RichEdit", StringComparison.OrdinalIgnoreCase)) return "edit";
    // WinForms: WindowsForms10.EDIT.app.0.141b42a_r6_ad1
    if (cls.StartsWith("WindowsForms10.", StringComparison.OrdinalIgnoreCase)) {
      var parts = cls.Split('.');
      if (parts.Length > 1 && Win32.TryGetValue(parts[1], out mapped)) return mapped;
    }
    return null;
  }

  /// The element's name. For classic Win32 controls seen as panes the name is the raw window
  /// text, which still contains the "&" mnemonic markers ("Do&n't Save"); remove them.
  public static string NameOf(AutomationElement el) {
    var c = el.Current;
    string name = c.Name ?? "";
    if (name.IndexOf('&') < 0 || c.ControlType != ControlType.Pane || FromClass(c.ClassName) == null) return name;
    var sb = new StringBuilder();
    for (int i = 0; i < name.Length; i++) {
      if (name[i] == '&') {
        if (i + 1 < name.Length && name[i + 1] == '&') { sb.Append('&'); i++; }
        continue;
      }
      sb.Append(name[i]);
    }
    return sb.ToString();
  }

  public static string Of(AutomationElement el) {
    var c = el.Current;
    string type = c.ControlType.ProgrammaticName.Replace("ControlType.", "").ToLowerInvariant();
    if (type == "pane") {
      string mapped = FromClass(c.ClassName);
      if (mapped != null) return mapped;
    }
    return type;
  }
}

/// Records clicks, typing and Enter across all applications using low-level
/// hooks plus UI Automation focus events. Events are JSON strings.
public static class ZtRecorder {
  delegate IntPtr HookProc(int code, IntPtr w, IntPtr l);
  [StructLayout(LayoutKind.Sequential)] struct POINT { public int x; public int y; }
  [StructLayout(LayoutKind.Sequential)] struct MSLL { public POINT pt; public uint data, flags, time; public IntPtr extra; }
  [StructLayout(LayoutKind.Sequential)] struct KBLL { public uint vk, scan, flags, time; public IntPtr extra; }
  [StructLayout(LayoutKind.Sequential)] struct MSG { public IntPtr hwnd; public uint message; public IntPtr w, l; public uint time; public POINT pt; }
  [DllImport("user32.dll", SetLastError = true)] static extern IntPtr SetWindowsHookEx(int id, HookProc fn, IntPtr mod, uint tid);
  [DllImport("user32.dll")] static extern bool UnhookWindowsHookEx(IntPtr h);
  [DllImport("user32.dll")] static extern IntPtr CallNextHookEx(IntPtr h, int code, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] static extern int GetMessage(out MSG m, IntPtr h, uint a, uint b);
  [DllImport("user32.dll")] static extern bool PostThreadMessage(uint tid, uint msg, IntPtr w, IntPtr l);
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
  [DllImport("kernel32.dll")] static extern IntPtr GetModuleHandle(string name);

  static HookProc mouseProc, keyProc;
  static IntPtr mouseHook, keyHook;
  static uint hookThreadId;
  static BlockingCollection<int[]> pending;
  static ConcurrentQueue<string> events = new ConcurrentQueue<string>();
  static volatile bool running;
  static readonly object gate = new object();
  static int ownPid = Process.GetCurrentProcess().Id;
  static AutomationFocusChangedEventHandler focusHandler;
  static AutomationElement field;
  static string fieldChain, fieldInitial;
  static bool fieldSecret;
  static int keysInField;

  public static void Start() {
    if (running) return;
    running = true;
    events = new ConcurrentQueue<string>();
    pending = new BlockingCollection<int[]>();
    new Thread(Work) { IsBackground = true }.Start();
    new Thread(HookLoop) { IsBackground = true }.Start();
    focusHandler = new AutomationFocusChangedEventHandler(OnFocus);
    Automation.AddAutomationFocusChangedEventHandler(focusHandler);
  }

  public static void Stop() {
    if (!running) return;
    Flush();
    running = false;
    try { Automation.RemoveAutomationFocusChangedEventHandler(focusHandler); } catch { }
    PostThreadMessage(hookThreadId, 0x0012, IntPtr.Zero, IntPtr.Zero);
    pending.CompleteAdding();
  }

  public static string[] Drain() {
    var list = new List<string>();
    string e;
    while (events.TryDequeue(out e)) list.Add(e);
    return list.ToArray();
  }

  static void HookLoop() {
    hookThreadId = GetCurrentThreadId();
    mouseProc = MouseHook;
    keyProc = KeyHook;
    IntPtr mod = GetModuleHandle(null);
    mouseHook = SetWindowsHookEx(14, mouseProc, mod, 0);
    keyHook = SetWindowsHookEx(13, keyProc, mod, 0);
    MSG m;
    while (GetMessage(out m, IntPtr.Zero, 0, 0) > 0) { }
    UnhookWindowsHookEx(mouseHook);
    UnhookWindowsHookEx(keyHook);
  }

  static IntPtr MouseHook(int code, IntPtr w, IntPtr l) {
    if (code >= 0 && running) {
      int msg = w.ToInt32();
      if (msg == 0x201 || msg == 0x204) {
        var d = (MSLL)Marshal.PtrToStructure(l, typeof(MSLL));
        pending.TryAdd(new[] { d.pt.x, d.pt.y, msg == 0x204 ? 1 : 0 });
      }
    }
    return CallNextHookEx(mouseHook, code, w, l);
  }

  static IntPtr KeyHook(int code, IntPtr w, IntPtr l) {
    if (code >= 0 && running) {
      int msg = w.ToInt32();
      if (msg == 0x100 || msg == 0x104) {
        var d = (KBLL)Marshal.PtrToStructure(l, typeof(KBLL));
        Interlocked.Increment(ref keysInField);
        if (d.vk == 0x0D) pending.TryAdd(new[] { 0, 0, 2 });
      }
    }
    return CallNextHookEx(keyHook, code, w, l);
  }

  static void Work() {
    foreach (var p in pending.GetConsumingEnumerable()) {
      try {
        if (p[2] == 2) {
          string chain;
          lock (gate) { chain = fieldChain; }
          Flush();
          if (chain != null) events.Enqueue("{\"kind\":\"enter\",\"chain\":" + chain + "}");
          continue;
        }
        Flush();
        var pt = new System.Windows.Point(p[0], p[1]);
        var el = AutomationElement.FromPoint(pt);
        if (el == null || el.Current.ProcessId == ownPid) continue;
        el = Deepest(el, pt);
        events.Enqueue("{\"kind\":\"" + (p[2] == 1 ? "rightclick" : "click") + "\",\"chain\":" + Chain(el) + "}");
      } catch (Exception ex) {
        events.Enqueue("{\"kind\":\"error\",\"message\":" + Json(ex.Message) + "}");
      }
    }
  }

  /// FromPoint stops at hosts such as WinUI/XAML islands (the new Notepad's
  /// menu bar) and Chromium panes; walk down to the smallest element under the point.
  static AutomationElement Deepest(AutomationElement el, System.Windows.Point pt) {
    var walker = TreeWalker.ControlViewWalker;
    int visited = 0;
    for (int depth = 0; depth < 25; depth++) {
      AutomationElement best = null;
      double bestArea = double.MaxValue;
      for (var c = walker.GetFirstChild(el); c != null && visited < 400; c = walker.GetNextSibling(c)) {
        visited++;
        try {
          if (c.Current.IsOffscreen) continue;
          var r = c.Current.BoundingRectangle;
          if (r.IsEmpty || !r.Contains(pt)) continue;
          double area = r.Width * r.Height;
          if (area < bestArea) { best = c; bestArea = area; }
        } catch { }
      }
      if (best == null) break;
      el = best;
    }
    return el;
  }

  static void OnFocus(object sender, AutomationFocusChangedEventArgs e) {
    try {
      Flush();
      var el = sender as AutomationElement;
      if (el == null || el.Current.ProcessId == ownPid || !IsField(el)) {
        lock (gate) { field = null; fieldChain = null; }
        return;
      }
      lock (gate) {
        field = el;
        fieldChain = Chain(el);
        fieldSecret = el.Current.IsPassword;
        fieldInitial = fieldSecret ? "" : ValueOf(el);
        keysInField = 0;
      }
    } catch { }
  }

  /// Emits a "type" event when the focused field's text changed.
  static void Flush() {
    lock (gate) {
      if (field == null) return;
      try {
        if (fieldSecret) {
          if (keysInField > 0) events.Enqueue("{\"kind\":\"type\",\"secret\":true,\"value\":\"\",\"chain\":" + fieldChain + "}");
        } else {
          string now = ValueOf(field);
          if (now != fieldInitial) events.Enqueue("{\"kind\":\"type\",\"value\":" + Json(now) + ",\"chain\":" + fieldChain + "}");
          fieldInitial = now;
        }
        keysInField = 0;
      } catch { }
    }
  }

  static bool IsField(AutomationElement el) {
    var type = el.Current.ControlType;
    if (type == ControlType.Edit || type == ControlType.Document || ZtTypes.Of(el) == "edit") return true;
    object p;
    if (el.TryGetCurrentPattern(ValuePattern.Pattern, out p)) return !((ValuePattern)p).Current.IsReadOnly && type != ControlType.ComboBox;
    return false;
  }

  public static string ValueOf(AutomationElement el) {
    object p;
    if (el.TryGetCurrentPattern(ValuePattern.Pattern, out p)) return ((ValuePattern)p).Current.Value ?? "";
    if (el.TryGetCurrentPattern(TextPattern.Pattern, out p)) return ((TextPattern)p).DocumentRange.GetText(100000) ?? "";
    // A Win32 edit seen as a plain pane exposes its text as the Name.
    return ZtTypes.Of(el) == "edit" ? (el.Current.Name ?? "") : "";
  }

  public static string Chain(AutomationElement el) {
    var walker = TreeWalker.ControlViewWalker;
    var root = AutomationElement.RootElement;
    var items = new List<string>();
    var node = el;
    for (int i = 0; node != null && i < 40 && !Automation.Compare(node, root); i++) {
      items.Insert(0, Describe(node, false));
      var parent = walker.GetParent(node);
      if (parent == null || Automation.Compare(parent, root)) {
        items[0] = Describe(node, true);
        break;
      }
      node = parent;
    }
    return "[" + string.Join(",", items.ToArray()) + "]";
  }

  static string Describe(AutomationElement el, bool top) {
    var c = el.Current;
    string type = ZtTypes.Of(el);
    var sb = new StringBuilder("{\"type\":" + Json(type) + ",\"name\":" + Json(ZtTypes.NameOf(el)) + ",\"id\":" + Json(c.AutomationId) + ",\"class\":" + Json(c.ClassName));
    if (c.IsPassword) sb.Append(",\"isPassword\":true");
    if (top) {
      try { sb.Append(",\"process\":" + Json(Process.GetProcessById(c.ProcessId).ProcessName)); } catch { }
    }
    return sb.Append("}").ToString();
  }

  public static string Json(string s) {
    if (s == null) return "\"\"";
    var sb = new StringBuilder("\"");
    foreach (char ch in s) {
      switch (ch) {
        case '"': sb.Append("\\\""); break;
        case '\\': sb.Append("\\\\"); break;
        case '\n': sb.Append("\\n"); break;
        case '\r': sb.Append("\\r"); break;
        case '\t': sb.Append("\\t"); break;
        default:
          if (ch < 0x20) sb.Append("\\u" + ((int)ch).ToString("x4")); else sb.Append(ch);
          break;
      }
    }
    return sb.Append("\"").ToString();
  }
}
'@

# "Indicate": the person clicks the application to record. The window under the
# mouse is outlined; the click is kept from the application; Esc cancels.
$IndicateSource = @'
using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Automation;
using System.Windows.Forms;

public static class ZtIndicate {
  [StructLayout(LayoutKind.Sequential)] struct POINT { public int x; public int y; }
  [StructLayout(LayoutKind.Sequential)] struct RECT { public int l, t, r, b; }
  [StructLayout(LayoutKind.Sequential)] struct MSLL { public POINT pt; public uint data, flags, time; public IntPtr extra; }
  [StructLayout(LayoutKind.Sequential)] struct KBLL { public uint vk, scan, flags, time; public IntPtr extra; }
  delegate IntPtr HookProc(int code, IntPtr w, IntPtr l);
  delegate bool EnumProc(IntPtr h, IntPtr p);
  [DllImport("user32.dll", SetLastError = true)] static extern IntPtr SetWindowsHookEx(int id, HookProc fn, IntPtr mod, uint tid);
  [DllImport("user32.dll")] static extern bool UnhookWindowsHookEx(IntPtr h);
  [DllImport("user32.dll")] static extern IntPtr CallNextHookEx(IntPtr h, int code, IntPtr w, IntPtr l);
  [DllImport("kernel32.dll")] static extern IntPtr GetModuleHandle(string name);
  [DllImport("user32.dll")] static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc fn, IntPtr p);
  [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr parent, EnumProc fn, IntPtr p);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr h, int index);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int attr, out int value, int size);
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int attr, out RECT value, int size);
  [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool QueryFullProcessImageName(IntPtr h, int flags, StringBuilder s, ref int n);

  static readonly HashSet<IntPtr> own = new HashSet<IntPtr>();
  static readonly int ownPid = Process.GetCurrentProcess().Id;
  static HookProc mouseProc, keyProc;
  static IntPtr mouseHook, keyHook, pressed, picked;
  static bool cancelled;
  /** Element mode: the control under the mouse is outlined and its point is picked. */
  static bool elementMode, pointPicked;
  static int pickX, pickY;
  /** F2: clicks go to the application for a few seconds (to open a menu before indicating in it). */
  static int pausedUntil;

  /** Outlines the window under the mouse; click-through, never activated. */
  class Outline : Form {
    public Outline() {
      FormBorderStyle = FormBorderStyle.None; ShowInTaskbar = false; TopMost = true; StartPosition = FormStartPosition.Manual;
      BackColor = Color.Magenta; TransparencyKey = Color.Magenta;
      Paint += (s, e) => {
        using (var pen = new Pen(Color.FromArgb(0x4f, 0x46, 0xe5), 6)) e.Graphics.DrawRectangle(pen, 3, 3, Width - 6, Height - 6);
      };
    }
    protected override bool ShowWithoutActivation { get { return true; } }
    protected override CreateParams CreateParams {
      get { var p = base.CreateParams; p.ExStyle |= 0x80000 | 0x20 | 0x80 | 0x08000000; return p; }
    }
  }

  /** What to do, at the top of the screen. */
  class Banner : Form {
    public Banner(string text) {
      FormBorderStyle = FormBorderStyle.None; ShowInTaskbar = false; TopMost = true; StartPosition = FormStartPosition.Manual;
      BackColor = Color.FromArgb(0x31, 0x2e, 0x81); Opacity = 0.95;
      var label = new Label { Text = text, AutoSize = true, Font = new Font("Segoe UI", 12f), ForeColor = Color.White, Location = new Point(20, 12) };
      Controls.Add(label);
      var size = label.GetPreferredSize(Size.Empty);
      ClientSize = new Size(size.Width + 40, size.Height + 24);
      var area = Screen.PrimaryScreen.WorkingArea;
      Location = new Point(area.Left + (area.Width - Width) / 2, area.Top + 24);
    }
    protected override bool ShowWithoutActivation { get { return true; } }
    protected override CreateParams CreateParams {
      get { var p = base.CreateParams; p.ExStyle |= 0x20 | 0x80 | 0x08000000; return p; }
    }
  }

  /** The application window the person clicks (null: Esc or the time ran out). */
  public static Hashtable Pick(int timeoutMs, string hint) {
    elementMode = false;
    return OnUiThread(timeoutMs, hint);
  }

  /** The point of the control the person clicks, as { x, y } (null: Esc or the time ran out). */
  public static Hashtable PickElement(int timeoutMs, string hint) {
    elementMode = true;
    return OnUiThread(timeoutMs, hint);
  }

  static Hashtable OnUiThread(int timeoutMs, string hint) {
    Hashtable result = null;
    var t = new Thread(() => { result = Run(timeoutMs, hint); });
    t.SetApartmentState(ApartmentState.STA);
    t.IsBackground = true;
    t.Start();
    t.Join();
    return result;
  }

  static Hashtable Run(int timeoutMs, string hint) {
    pressed = picked = IntPtr.Zero;
    cancelled = pointPicked = false;
    pausedUntil = 0;
    own.Clear();
    int lastX = int.MinValue, lastY = int.MinValue, lastLook = 0;
    var outline = new Outline();
    var banner = new Banner(hint);
    own.Add(outline.Handle);
    own.Add(banner.Handle);
    banner.Show();
    int started = Environment.TickCount;
    var timer = new System.Windows.Forms.Timer { Interval = 50 };
    timer.Tick += (s, e) => {
      if (picked != IntPtr.Zero || pointPicked || cancelled || Environment.TickCount - started > timeoutMs) { Application.ExitThread(); return; }
      POINT p;
      GetCursorPos(out p);
      if (elementMode) {
        // Asking UI Automation is slow: only when the mouse moved, at most every 120 ms.
        if ((p.x == lastX && p.y == lastY) || Environment.TickCount - lastLook < 120) return;
        lastX = p.x; lastY = p.y; lastLook = Environment.TickCount;
        var box = ElementBox(p.x, p.y);
        if (box.HasValue) {
          if (outline.Bounds != box.Value) { outline.Bounds = box.Value; outline.Invalidate(); }
          if (!outline.Visible) outline.Show();
        } else if (outline.Visible) outline.Hide();
        return;
      }
      IntPtr h = WindowAt(p.x, p.y);
      RECT r;
      if (h != IntPtr.Zero && Bounds(h, out r)) {
        var box = new Rectangle(r.l - 3, r.t - 3, r.r - r.l + 6, r.b - r.t + 6);
        if (outline.Bounds != box) { outline.Bounds = box; outline.Invalidate(); }
        if (!outline.Visible) outline.Show();
      } else if (outline.Visible) outline.Hide();
    };
    mouseProc = MouseHook;
    keyProc = KeyHook;
    IntPtr mod = GetModuleHandle(null);
    mouseHook = SetWindowsHookEx(14, mouseProc, mod, 0);
    keyHook = SetWindowsHookEx(13, keyProc, mod, 0);
    timer.Start();
    try { Application.Run(); }
    finally {
      timer.Stop();
      UnhookWindowsHookEx(mouseHook);
      UnhookWindowsHookEx(keyHook);
      outline.Close();
      banner.Close();
    }
    if (elementMode) {
      if (!pointPicked) return null;
      var point = new Hashtable();
      point["x"] = pickX;
      point["y"] = pickY;
      return point;
    }
    return picked == IntPtr.Zero ? null : Describe(picked);
  }

  /** The screen box of the smallest control under a point (not these overlays). */
  static Rectangle? ElementBox(int x, int y) {
    try {
      var pt = new System.Windows.Point(x, y);
      var el = AutomationElement.FromPoint(pt);
      if (el == null || el.Current.ProcessId == ownPid) return null;
      el = Smallest(el, pt);
      var r = el.Current.BoundingRectangle;
      if (r.IsEmpty) return null;
      return new Rectangle((int)r.X - 3, (int)r.Y - 3, (int)r.Width + 6, (int)r.Height + 6);
    } catch { return null; }
  }

  /** Walks down to the smallest control under the point (as the recorder does). */
  public static AutomationElement Smallest(AutomationElement el, System.Windows.Point pt) {
    var walker = TreeWalker.ControlViewWalker;
    int visited = 0;
    for (int depth = 0; depth < 25; depth++) {
      AutomationElement best = null;
      double bestArea = double.MaxValue;
      for (var c = walker.GetFirstChild(el); c != null && visited < 400; c = walker.GetNextSibling(c)) {
        visited++;
        try {
          if (c.Current.IsOffscreen) continue;
          var r = c.Current.BoundingRectangle;
          if (r.IsEmpty || !r.Contains(pt)) continue;
          double area = r.Width * r.Height;
          if (area < bestArea) { best = c; bestArea = area; }
        } catch { }
      }
      if (best == null) break;
      el = best;
    }
    return el;
  }

  /** A left click picks what is under it; the application gets neither the press nor the release (unless paused with F2). */
  static IntPtr MouseHook(int code, IntPtr w, IntPtr l) {
    if (code >= 0 && Environment.TickCount >= pausedUntil) {
      int msg = w.ToInt32();
      if (msg == 0x201) {
        var d = (MSLL)Marshal.PtrToStructure(l, typeof(MSLL));
        if (elementMode) { pickX = d.pt.x; pickY = d.pt.y; pressed = (IntPtr)1; }
        else pressed = WindowAt(d.pt.x, d.pt.y);
        return (IntPtr)1;
      }
      if (msg == 0x202) {
        if (elementMode) { if (pressed != IntPtr.Zero) pointPicked = true; }
        else if (pressed != IntPtr.Zero) picked = pressed;
        return (IntPtr)1;
      }
    }
    return CallNextHookEx(mouseHook, code, w, l);
  }

  static IntPtr KeyHook(int code, IntPtr w, IntPtr l) {
    if (code >= 0 && w.ToInt32() == 0x100) {
      var k = (KBLL)Marshal.PtrToStructure(l, typeof(KBLL));
      if (k.vk == 0x1B) { cancelled = true; return (IntPtr)1; }
      if (k.vk == 0x71) { pausedUntil = Environment.TickCount + 5000; return (IntPtr)1; }
    }
    return CallNextHookEx(keyHook, code, w, l);
  }

  /** The top-most application window at a point (not the desktop, the taskbar or these overlays). */
  static IntPtr WindowAt(int x, int y) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((h, unused) => {
      if (own.Contains(h) || !IsWindowVisible(h) || IsIconic(h)) return true;
      int cloaked;
      if (DwmGetWindowAttribute(h, 14, out cloaked, 4) == 0 && cloaked != 0) return true;
      if ((GetWindowLong(h, -20) & 0x20) != 0) return true;
      RECT r;
      if (!Bounds(h, out r) || x < r.l || x >= r.r || y < r.t || y >= r.b) return true;
      uint pid;
      GetWindowThreadProcessId(h, out pid);
      if (pid == ownPid) return true;
      found = h;
      return false;
    }, IntPtr.Zero);
    if (found == IntPtr.Zero) return found;
    var cls = new StringBuilder(256);
    GetClassName(found, cls, 256);
    string c = cls.ToString();
    return c == "Progman" || c == "WorkerW" || c == "Shell_TrayWnd" || c == "Shell_SecondaryTrayWnd" ? IntPtr.Zero : found;
  }

  static bool Bounds(IntPtr h, out RECT r) {
    if (DwmGetWindowAttribute(h, 9, out r, Marshal.SizeOf(typeof(RECT))) == 0 && r.r > r.l) return true;
    return GetWindowRect(h, out r) && r.r > r.l && r.b > r.t;
  }

  static Hashtable Describe(IntPtr h) {
    uint pid;
    GetWindowThreadProcessId(h, out pid);
    // Store apps (Calculator, ...): the frame is ApplicationFrameHost's, the app is a child window's process.
    if (NameOf(pid) == "applicationframehost") {
      uint inner = 0;
      uint frame = pid;
      EnumChildWindows(h, (c, unused) => {
        uint p;
        GetWindowThreadProcessId(c, out p);
        if (p != frame) { inner = p; return false; }
        return true;
      }, IntPtr.Zero);
      if (inner != 0) pid = inner;
    }
    var title = new StringBuilder(512);
    GetWindowText(h, title, 512);
    var result = new Hashtable();
    result["path"] = PathOf(pid);
    result["process"] = NameOf(pid);
    result["title"] = title.ToString();
    return result;
  }

  static string NameOf(uint pid) {
    try { return Process.GetProcessById((int)pid).ProcessName.ToLowerInvariant(); } catch { return ""; }
  }

  static string PathOf(uint pid) {
    IntPtr h = OpenProcess(0x1000, false, pid);
    if (h == IntPtr.Zero) return "";
    try {
      var sb = new StringBuilder(1024);
      int n = sb.Capacity;
      return QueryFullProcessImageName(h, 0, sb, ref n) ? sb.ToString() : "";
    } finally { CloseHandle(h); }
  }
}
'@

function Initialize-Indicate {
  if ($script:IndicateReady) { return }
  $refs = @(
    [System.Windows.Forms.Form].Assembly.Location,
    [System.Drawing.Color].Assembly.Location,
    [System.Windows.Automation.AutomationElement].Assembly.Location,
    [System.Windows.Automation.ControlType].Assembly.Location,
    [System.Windows.Point].Assembly.Location
  )
  Add-Type -TypeDefinition $IndicateSource -ReferencedAssemblies $refs -Language CSharp
  $script:IndicateReady = $true
}

function Initialize-Uia {
  if ($script:UiaReady) { return }
  if ($PSVersionTable.PSEdition -eq 'Core' -and -not $IsWindows) { throw 'Desktop automation needs Windows.' }
  Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, WindowsBase, System.Windows.Forms, System.Drawing
  $refs = @(
    [System.Windows.Automation.AutomationElement].Assembly.Location,
    [System.Windows.Automation.ControlType].Assembly.Location,
    [System.Windows.Point].Assembly.Location
  )
  Add-Type -TypeDefinition $NativeSource -ReferencedAssemblies $refs -Language CSharp
  [ZtNative]::Init()
  foreach ($field in [System.Windows.Automation.ControlType].GetFields([System.Reflection.BindingFlags]'Public,Static')) {
    $script:ControlTypes[$field.Name.ToLowerInvariant()] = $field.GetValue($null)
  }
  $script:MappedTypes = New-Object 'System.Collections.Generic.HashSet[string]'
  foreach ($t in @('window', 'edit', 'button', 'combobox', 'list', 'tree', 'text', 'statusbar', 'tab', 'toolbar', 'progressbar', 'slider', 'hyperlink', 'header', 'scrollbar')) { [void]$script:MappedTypes.Add($t) }
  $script:UiaReady = $true
}

function ConvertTo-JsonLine($value) {
  return [ZtJson]::Write($value)
}

function Get-ProcessName([int]$processId) {
  if (-not $script:ProcessNames.ContainsKey($processId)) {
    try { $script:ProcessNames[$processId] = (Get-Process -Id $processId).ProcessName } catch { $script:ProcessNames[$processId] = '' }
  }
  return $script:ProcessNames[$processId]
}

function Test-Condition($element, $condition) {
  $current = $element.Current
  $actual = switch ($condition.attr) {
    'name' { [ZtTypes]::NameOf($element) }
    'id' { $current.AutomationId }
    'class' { $current.ClassName }
    'process' { Get-ProcessName $current.ProcessId }
  }
  if ($null -eq $actual) { $actual = '' }
  $expected = [string]$condition.value
  $cmp = [System.StringComparison]::OrdinalIgnoreCase
  switch ($condition.op) {
    '=' { return [string]::Equals($actual, $expected, $cmp) }
    '~=' { return $actual.IndexOf($expected, $cmp) -ge 0 }
    '^=' { return $actual.StartsWith($expected, $cmp) }
    '$=' { return $actual.EndsWith($expected, $cmp) }
  }
  return $false
}

function Find-Segment($parents, $segment, [bool]$topLevel) {
  $scope = if ($topLevel) { [System.Windows.Automation.TreeScope]::Children } else { [System.Windows.Automation.TreeScope]::Descendants }
  $condition = [System.Windows.Automation.Condition]::TrueCondition
  $wanted = [string]$segment.type
  if ($wanted -ne '*') {
    $ct = $script:ControlTypes[$wanted]
    if ($null -eq $ct) { throw "Unknown control type '$wanted'" }
    $property = [System.Windows.Automation.AutomationElement]::ControlTypeProperty
    $condition = New-Object System.Windows.Automation.PropertyCondition($property, $ct)
    if ($script:MappedTypes.Contains($wanted)) {
      # Also look at panes: classic Win32 controls may only be exposed as panes (see ZtTypes).
      $pane = New-Object System.Windows.Automation.PropertyCondition($property, [System.Windows.Automation.ControlType]::Pane)
      $condition = New-Object System.Windows.Automation.OrCondition($condition, $pane)
    }
  }
  $found = New-Object System.Collections.Generic.List[object]
  foreach ($parent in $parents) {
    foreach ($el in $parent.FindAll($scope, $condition)) {
      if ($wanted -ne '*' -and [ZtTypes]::Of($el) -ne $wanted) { continue }
      $ok = $true
      foreach ($c in $segment.conditions) { if (-not (Test-Condition $el $c)) { $ok = $false; break } }
      if ($ok) { $found.Add($el) }
    }
  }
  if ($segment.index) {
    $i = [int]$segment.index - 1
    if ($i -lt $found.Count) { return , @($found[$i]) }
    return , @()
  }
  return , $found.ToArray()
}

function Resolve-Selector($segments) {
  $current = @([System.Windows.Automation.AutomationElement]::RootElement)
  $top = $true
  foreach ($segment in $segments) {
    $current = Find-Segment $current $segment $top
    $top = $false
    if ($current.Count -eq 0) { return , @() }
  }
  return , $current
}

function Wait-Element($selector, [int]$timeoutMs) {
  $deadline = [DateTime]::UtcNow.AddMilliseconds([Math]::Max(0, $timeoutMs))
  do {
    $found = Resolve-Selector $selector
    if ($found.Count -gt 0) { return $found[0] }
    Start-Sleep -Milliseconds 250
  } while ([DateTime]::UtcNow -lt $deadline)
  throw 'Element not found'
}

function Get-Pattern($element, $pattern) {
  $p = $null
  if ($element.TryGetCurrentPattern($pattern, [ref]$p)) { return $p }
  return $null
}

function Get-Info($element) {
  $c = $element.Current
  $r = $c.BoundingRectangle
  # Minimised and off-screen elements have an empty (infinite) rectangle.
  $rect = if ($r.IsEmpty -or [double]::IsInfinity($r.X) -or [double]::IsInfinity($r.Width)) { $null } else { @{ x = [int]$r.X; y = [int]$r.Y; width = [int]$r.Width; height = [int]$r.Height } }
  return @{
    type = [ZtTypes]::Of($element)
    name = [ZtTypes]::NameOf($element); id = $c.AutomationId; class = $c.ClassName
    process = (Get-ProcessName $c.ProcessId); enabled = $c.IsEnabled
    rect = $rect
  }
}

function Focus-Element($element) {
  try {
    $hwnd = $element.Current.NativeWindowHandle
    $node = $element
    while ($hwnd -eq 0 -and $null -ne $node) {
      $node = [System.Windows.Automation.TreeWalker]::ControlViewWalker.GetParent($node)
      if ($null -ne $node) { $hwnd = $node.Current.NativeWindowHandle }
    }
    if ($hwnd -ne 0) { [void][ZtNative]::SetForegroundWindow([IntPtr]$hwnd) }
  } catch { }
  try { $element.SetFocus() } catch { }
}

function Invoke-MouseClick($element, [bool]$right, [bool]$double) {
  Focus-Element $element
  $point = New-Object System.Windows.Point
  if (-not $element.TryGetClickablePoint([ref]$point)) {
    $r = $element.Current.BoundingRectangle
    if ($r.IsEmpty) { throw 'The element is not on screen' }
    $point = New-Object System.Windows.Point(($r.X + $r.Width / 2), ($r.Y + $r.Height / 2))
  }
  [ZtNative]::Click([int]$point.X, [int]$point.Y, $right, $double)
}

function ConvertTo-SendKeysText([string]$text) {
  $sb = New-Object System.Text.StringBuilder
  foreach ($ch in $text.ToCharArray()) {
    switch -CaseSensitive ($ch) {
      "`n" { [void]$sb.Append('{ENTER}'); continue }
      "`r" { continue }
      "`t" { [void]$sb.Append('{TAB}'); continue }
      default {
        if ('+^%~(){}[]'.IndexOf($ch) -ge 0) { [void]$sb.Append('{' + $ch + '}') } else { [void]$sb.Append($ch) }
      }
    }
  }
  return $sb.ToString()
}

function Get-ElementText($element) {
  $value = Get-Pattern $element ([System.Windows.Automation.ValuePattern]::Pattern)
  if ($value -and $value.Current.Value) { return $value.Current.Value }
  $text = Get-Pattern $element ([System.Windows.Automation.TextPattern]::Pattern)
  if ($text) { return $text.DocumentRange.GetText(-1) }
  return $element.Current.Name
}

function Get-Tree($element, [int]$depth, [int]$maxNodes) {
  $lines = New-Object System.Collections.Generic.List[string]
  $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
  $walk = {
    param($node, $level)
    if ($lines.Count -ge $maxNodes -or $level -gt $depth) { return }
    $c = $node.Current
    $line = ('  ' * $level) + [ZtTypes]::Of($node)
    $name = [ZtTypes]::NameOf($node)
    if ($name) { $line += ' name="' + ($name -replace '"', '\"' -replace "`r?`n", ' ') + '"' }
    if ($c.AutomationId) { $line += ' id="' + $c.AutomationId + '"' }
    if ($c.ClassName) { $line += ' class="' + $c.ClassName + '"' }
    if ($level -eq 0) { $line += ' process="' + (Get-ProcessName $c.ProcessId) + '"' }
    $lines.Add($line)
    $child = $walker.GetFirstChild($node)
    while ($null -ne $child -and $lines.Count -lt $maxNodes) {
      & $walk $child ($level + 1)
      $child = $walker.GetNextSibling($child)
    }
  }
  & $walk $element 0
  return ($lines -join "`n")
}

function Invoke-Op([string]$op, $a) {
  Initialize-Uia
  $timeout = if ($a.timeoutMs) { [int]$a.timeoutMs } else { 10000 }
  switch ($op) {
    'launch' {
      $params = @{ FilePath = [string]$a.path; PassThru = $true }
      if ($a.args) { $params.ArgumentList = [string]$a.args }
      $proc = Start-Process @params
      try { [void]$proc.WaitForInputIdle(10000) } catch { }
      return @{ pid = $proc.Id }
    }
    'info' { return @{ win32 = 'class-name mapping'; powershell = $PSVersionTable.PSVersion.ToString(); clr = [Environment]::Version.ToString() } }
    'windows' {
      $list = New-Object System.Collections.Generic.List[object]
      $root = [System.Windows.Automation.AutomationElement]::RootElement
      foreach ($w in $root.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)) {
        if ($w.Current.Name) { $list.Add((Get-Info $w)) }
      }
      return , $list
    }
    'count' { return @{ count = (Resolve-Selector $a.selector).Count } }
    'find' {
      $el = Wait-Element $a.selector $timeout
      $info = Get-Info $el
      $info.count = (Resolve-Selector $a.selector).Count
      return $info
    }
    'waitFor' {
      if ($a.state -eq 'gone') {
        $deadline = [DateTime]::UtcNow.AddMilliseconds($timeout)
        while ((Resolve-Selector $a.selector).Count -gt 0) {
          if ([DateTime]::UtcNow -gt $deadline) { throw 'Element is still there' }
          Start-Sleep -Milliseconds 250
        }
        return @{ ok = $true }
      }
      return Get-Info (Wait-Element $a.selector $timeout)
    }
    'click' {
      $el = Wait-Element $a.selector $timeout
      $right = $a.button -eq 'right'
      $double = [bool]$a.double
      if (-not $right -and -not $double -and $a.mode -ne 'mouse') {
        $invoke = Get-Pattern $el ([System.Windows.Automation.InvokePattern]::Pattern)
        if ($invoke) { $invoke.Invoke(); return @{ method = 'invoke' } }
        $toggle = Get-Pattern $el ([System.Windows.Automation.TogglePattern]::Pattern)
        if ($toggle) { $toggle.Toggle(); return @{ method = 'toggle' } }
        $select = Get-Pattern $el ([System.Windows.Automation.SelectionItemPattern]::Pattern)
        if ($select) { $select.Select(); return @{ method = 'select' } }
        $expand = Get-Pattern $el ([System.Windows.Automation.ExpandCollapsePattern]::Pattern)
        if ($expand) { $expand.Expand(); return @{ method = 'expand' } }
      }
      Invoke-MouseClick $el $right $double
      return @{ method = 'mouse' }
    }
    'type' {
      $el = Wait-Element $a.selector $timeout
      $text = [string]$a.text
      $clear = $a.clear -ne $false
      $done = $false
      $value = Get-Pattern $el ([System.Windows.Automation.ValuePattern]::Pattern)
      if ($clear -and $value -and -not $value.Current.IsReadOnly -and -not $el.Current.IsPassword) {
        try {
          $value.SetValue($text)
          $done = ($value.Current.Value -eq $text)
        } catch { $done = $false }
      }
      if (-not $done) {
        Focus-Element $el
        Start-Sleep -Milliseconds 100
        if ($clear) { [System.Windows.Forms.SendKeys]::SendWait('^a{DEL}') }
        [System.Windows.Forms.SendKeys]::SendWait((ConvertTo-SendKeysText $text))
      }
      if ($a.pressEnter) {
        Focus-Element $el
        [System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
      }
      return @{ method = $(if ($done) { 'value' } else { 'keys' }) }
    }
    'sendKeys' {
      if ($a.selector) { Focus-Element (Wait-Element $a.selector $timeout); Start-Sleep -Milliseconds 100 }
      [System.Windows.Forms.SendKeys]::SendWait([string]$a.keys)
      return @{ ok = $true }
    }
    'getText' { return @{ text = (Get-ElementText (Wait-Element $a.selector $timeout)) } }
    'select' {
      $el = Wait-Element $a.selector $timeout
      $wanted = [string]$a.value
      $expand = Get-Pattern $el ([System.Windows.Automation.ExpandCollapsePattern]::Pattern)
      if ($expand) { try { $expand.Expand(); Start-Sleep -Milliseconds 200 } catch { } }
      $cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::ListItem)
      foreach ($item in $el.FindAll([System.Windows.Automation.TreeScope]::Descendants, $cond)) {
        if ([string]::Equals($item.Current.Name, $wanted, [System.StringComparison]::OrdinalIgnoreCase)) {
          $sel = Get-Pattern $item ([System.Windows.Automation.SelectionItemPattern]::Pattern)
          if ($sel) { $sel.Select() } else { Invoke-MouseClick $item $false $false }
          if ($expand) { try { $expand.Collapse() } catch { } }
          return @{ selected = $item.Current.Name }
        }
      }
      $value = Get-Pattern $el ([System.Windows.Automation.ValuePattern]::Pattern)
      if ($value -and -not $value.Current.IsReadOnly) { $value.SetValue($wanted); return @{ selected = $wanted } }
      if ($expand) { try { $expand.Collapse() } catch { } }
      throw "Option '$wanted' not found"
    }
    'readTable' {
      $el = Wait-Element $a.selector $timeout
      $headers = New-Object System.Collections.Generic.List[string]
      $rows = New-Object System.Collections.Generic.List[object]
      $table = Get-Pattern $el ([System.Windows.Automation.TablePattern]::Pattern)
      if ($table) { foreach ($h in $table.Current.GetColumnHeaders()) { $headers.Add($h.Current.Name) } }
      $grid = Get-Pattern $el ([System.Windows.Automation.GridPattern]::Pattern)
      if ($grid) {
        for ($r = 0; $r -lt $grid.Current.RowCount; $r++) {
          $row = New-Object System.Collections.Generic.List[string]
          for ($c = 0; $c -lt $grid.Current.ColumnCount; $c++) {
            $cell = $grid.GetItem($r, $c)
            $row.Add($(if ($cell) { Get-ElementText $cell } else { '' }))
          }
          $rows.Add($row)
        }
      } else {
        $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
        $item = $walker.GetFirstChild($el)
        while ($null -ne $item) {
          $row = New-Object System.Collections.Generic.List[string]
          $cell = $walker.GetFirstChild($item)
          if ($null -eq $cell) { $row.Add((Get-ElementText $item)) }
          while ($null -ne $cell) { $row.Add((Get-ElementText $cell)); $cell = $walker.GetNextSibling($cell) }
          $rows.Add($row)
          $item = $walker.GetNextSibling($item)
        }
      }
      return @{ headers = $headers; rows = $rows }
    }
    'close' {
      $el = Wait-Element $a.selector $timeout
      # Post WM_CLOSE instead of WindowPattern.Close(): Close() waits until the window has
      # handled the message, which never happens while it shows a "Save changes?" prompt.
      $hwnd = $el.Current.NativeWindowHandle
      $window = Get-Pattern $el ([System.Windows.Automation.WindowPattern]::Pattern)
      if ($hwnd -ne 0) { [void][ZtNative]::PostMessage([IntPtr]$hwnd, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero) }
      elseif ($window) { $window.Close() }
      else { Focus-Element $el; [System.Windows.Forms.SendKeys]::SendWait('%{F4}') }
      return @{ ok = $true }
    }
    'tree' {
      $maxNodes = if ($a.maxNodes) { [int]$a.maxNodes } else { 1500 }
      $depth = if ($a.depth) { [int]$a.depth } else { 25 }
      if ($a.selector) {
        $roots = Resolve-Selector $a.selector
        if ($roots.Count -eq 0) { throw 'Window not found' }
        return @{ tree = (Get-Tree $roots[0] $depth $maxNodes) }
      }
      return @{ tree = (Get-Tree ([System.Windows.Automation.AutomationElement]::RootElement) 1 $maxNodes) }
    }
    'screenshot' {
      $bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
      if ($a.selector) {
        $r = (Wait-Element $a.selector $timeout).Current.BoundingRectangle
        $bounds = New-Object System.Drawing.Rectangle([int]$r.X, [int]$r.Y, [int]$r.Width, [int]$r.Height)
      }
      $bmp = New-Object System.Drawing.Bitmap($bounds.Width, $bounds.Height)
      $g = [System.Drawing.Graphics]::FromImage($bmp)
      $g.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
      $bmp.Save([string]$a.path, [System.Drawing.Imaging.ImageFormat]::Png)
      $g.Dispose(); $bmp.Dispose()
      return @{ path = [string]$a.path }
    }
    'snapshot' {
      # The whole screen as a small JPEG (base64), for the job's step screenshots.
      $bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
      $bmp = New-Object System.Drawing.Bitmap($bounds.Width, $bounds.Height)
      $g = [System.Drawing.Graphics]::FromImage($bmp)
      $g.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
      $g.Dispose()
      $maxWidth = if ($a.maxWidth) { [int]$a.maxWidth } else { 1600 }
      if ($bmp.Width -gt $maxWidth) {
        $height = [int]($bmp.Height * $maxWidth / $bmp.Width)
        $small = New-Object System.Drawing.Bitmap($maxWidth, $height)
        $gs = [System.Drawing.Graphics]::FromImage($small)
        $gs.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $gs.DrawImage($bmp, 0, 0, $maxWidth, $height)
        $gs.Dispose(); $bmp.Dispose(); $bmp = $small
      }
      $codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }
      $params = New-Object System.Drawing.Imaging.EncoderParameters(1)
      $quality = if ($a.quality) { [long]$a.quality } else { [long]60 }
      $params.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality, $quality)
      $ms = New-Object System.IO.MemoryStream
      $bmp.Save($ms, $codec, $params)
      $bmp.Dispose()
      $data = [Convert]::ToBase64String($ms.ToArray())
      $ms.Dispose()
      return @{ data = $data }
    }
    'indicateWindow' {
      Initialize-Indicate
      $hint = if ($a.hint) { [string]$a.hint } else { 'Click the application you want to record (Esc to cancel)' }
      return [ZtIndicate]::Pick($timeout, $hint)
    }
    'indicateElement' {
      # The control the person clicks, as the recorder describes it (window first): the caller makes the selector.
      Initialize-Indicate
      $hint = if ($a.hint) { [string]$a.hint } else { 'Click the element (Esc to cancel, F2 to use the application for 5 seconds)' }
      $picked = [ZtIndicate]::PickElement($timeout, $hint)
      if ($null -eq $picked) { return $null }
      $pt = New-Object System.Windows.Point([double]$picked.x, [double]$picked.y)
      $el = [System.Windows.Automation.AutomationElement]::FromPoint($pt)
      if ($null -eq $el) { return $null }
      $el = [ZtIndicate]::Smallest($el, $pt)
      return @{ chain = [ZtRecorder]::Chain($el) }
    }
    'recordStart' { [ZtRecorder]::Start(); return @{ ok = $true } }
    'recordPoll' { return , ([ZtRecorder]::Drain()) }
    'recordStop' { [ZtRecorder]::Stop(); return , ([ZtRecorder]::Drain()) }
    default { throw "Unknown operation '$op'" }
  }
}

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  if (-not $line.Trim()) { continue }
  $id = $null
  try {
    $request = $line | ConvertFrom-Json
    $id = $request.id
    # ping is answered here, before Invoke-Op is compiled (that needs the Windows-only assemblies).
    if ($request.op -eq 'ping') {
      $result = @{ pong = $true; powershell = $PSVersionTable.PSVersion.ToString(); windows = [bool]($env:OS -eq 'Windows_NT') }
    } else {
      $result = Invoke-Op ([string]$request.op) $request.args
    }
    $out = ConvertTo-JsonLine @{ id = $id; ok = $true; result = $result }
  } catch {
    $out = ConvertTo-JsonLine @{ id = $id; ok = $false; error = $_.Exception.Message }
  }
  [Console]::Out.WriteLine($out)
  [Console]::Out.Flush()
}
