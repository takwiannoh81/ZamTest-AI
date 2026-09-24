const ICONS: Record<string, string> = {
  list: "☰", split: "⑂", repeat: "↻", loop: "⟳", shield: "⛨", stop: "⏹", alert: "⚠", message: "✉",
  equals: "=", clock: "⏱", note: "✎", key: "🔑", code: "{}", globe: "🌐", braces: "{ }", file: "📄",
  save: "💾", browser: "🧭", arrow: "➜", pointer: "👆", keyboard: "⌨", text: "T", hourglass: "⌛",
  camera: "📷", close: "✕", sparkles: "✨", table: "▦", robot: "🤖", window: "🗔", rocket: "🚀",
};

export function iconFor(name?: string): string {
  return (name && ICONS[name]) || "•";
}

export const CATEGORY_COLORS: Record<string, string> = {
  "Control Flow": "#7c3aed",
  System: "#475569",
  "Data & Integration": "#0891b2",
  Files: "#ca8a04",
  Browser: "#2563eb",
  AI: "#db2777",
  "Excel & CSV": "#16a34a",
  Email: "#ea580c",
  PDF: "#dc2626",
  "Work Queues": "#0d9488",
  Desktop: "#4f46e5",
  Verify: "#059669",
};
