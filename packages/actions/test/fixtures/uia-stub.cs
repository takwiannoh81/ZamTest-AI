// Minimal stand-ins for the UI Automation types driver.ps1 uses, so its C# can be
// compile-checked (as C# 5, like Windows PowerShell 5.1 does) on machines without Windows.
namespace System.Windows { public struct Point { public Point(double x, double y) { X = x; Y = y; } public double X, Y; } }
namespace System.Windows.Automation {
  public delegate void AutomationFocusChangedEventHandler(object sender, AutomationFocusChangedEventArgs e);
  public class AutomationFocusChangedEventArgs : System.EventArgs {}
  public static class Automation {
    public static void AddAutomationFocusChangedEventHandler(AutomationFocusChangedEventHandler h) {}
    public static void RemoveAutomationFocusChangedEventHandler(AutomationFocusChangedEventHandler h) {}
    public static bool Compare(AutomationElement a, AutomationElement b) { return false; }
  }
  public class ControlType { public string ProgrammaticName; public static ControlType Edit, Document, ComboBox; }
  public class AutomationPattern {}
  public class AutomationElement {
    public static AutomationElement RootElement;
    public static AutomationElement FromPoint(System.Windows.Point p) { return null; }
    public Info Current;
    public struct Info { public int ProcessId; public bool IsPassword; public ControlType ControlType; public string Name, AutomationId, ClassName; }
    public bool TryGetCurrentPattern(AutomationPattern p, out object o) { o = null; return false; }
  }
  public class ValuePattern { public static AutomationPattern Pattern; public Info Current; public struct Info { public bool IsReadOnly; public string Value; } }
  public class TextPatternRange { public string GetText(int n) { return ""; } }
  public class TextPattern { public static AutomationPattern Pattern; public TextPatternRange DocumentRange; }
  public class TreeWalker { public static TreeWalker ControlViewWalker; public AutomationElement GetParent(AutomationElement e) { return null; } }
}
