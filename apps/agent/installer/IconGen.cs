// Draws the ZamTech AI logo (apps/website/public/favicon.svg) into a Windows
// .ico with PNG frames, and optionally the setup wizard's images (the panel on
// the left of the first and last pages, the small logo at the top of the
// others) in every size Inno Setup picks from for the display scaling.
// Used by scripts/build-installer.mjs:
//   IconGen.exe out.ico [wizard image folder]

using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;

static class IconGen {
  static int Main(string[] args) {
    if (args.Length < 1 || args.Length > 2) {
      Console.Error.WriteLine("Usage: IconGen.exe out.ico [wizard image folder]");
      return 1;
    }
    if (args.Length == 2) WizardImages(args[1]);
    int[] sizes = { 16, 20, 24, 32, 40, 48, 64, 256 };
    var frames = new List<byte[]>();
    foreach (int size in sizes) frames.Add(Draw(size));

    using (var w = new BinaryWriter(File.Create(args[0]))) {
      w.Write((short)0);
      w.Write((short)1);
      w.Write((short)sizes.Length);
      int offset = 6 + 16 * sizes.Length;
      for (int i = 0; i < sizes.Length; i++) {
        w.Write((byte)(sizes[i] >= 256 ? 0 : sizes[i]));
        w.Write((byte)(sizes[i] >= 256 ? 0 : sizes[i]));
        w.Write((byte)0);
        w.Write((byte)0);
        w.Write((short)1);
        w.Write((short)32);
        w.Write(frames[i].Length);
        w.Write(offset);
        offset += frames[i].Length;
      }
      foreach (var f in frames) w.Write(f);
    }
    return 0;
  }

  /// The favicon is drawn on a 64x64 grid.
  static byte[] Draw(int size) {
    using (var bmp = new Bitmap(size, size, PixelFormat.Format32bppArgb))
    using (var g = Graphics.FromImage(bmp)) {
      g.SmoothingMode = SmoothingMode.AntiAlias;
      g.PixelOffsetMode = PixelOffsetMode.HighQuality;
      float s = size / 64f;
      g.ScaleTransform(s, s);

      using (var tile = RoundedRect(0, 0, 64, 64, 16))
      using (var brush = new LinearGradientBrush(new PointF(0, 0), new PointF(64, 64), Color.FromArgb(0x4f, 0x46, 0xe5), Color.FromArgb(0x06, 0xb6, 0xd4))) {
        g.FillPath(brush, tile);
      }
      // M20 20h24v5L27 40h17v4H20v-5l17-15H20z
      var z = new PointF[] {
        new PointF(20, 20), new PointF(44, 20), new PointF(44, 25), new PointF(27, 40), new PointF(44, 40),
        new PointF(44, 44), new PointF(20, 44), new PointF(20, 39), new PointF(37, 24), new PointF(20, 24),
      };
      g.FillPolygon(Brushes.White, z);

      using (var ms = new MemoryStream()) {
        bmp.Save(ms, ImageFormat.Png);
        return ms.ToArray();
      }
    }
  }

  static readonly Color Indigo = Color.FromArgb(0x4f, 0x46, 0xe5);
  static readonly Color Cyan = Color.FromArgb(0x06, 0xb6, 0xd4);

  /// The sizes Inno Setup's modern wizard uses at 100% to 250% scaling.
  static void WizardImages(string dir) {
    Directory.CreateDirectory(dir);
    int[,] large = { { 164, 314 }, { 192, 386 }, { 246, 459 }, { 273, 556 }, { 328, 604 }, { 355, 700 }, { 410, 797 } };
    int[,] small = { { 55, 55 }, { 64, 68 }, { 83, 80 }, { 92, 97 }, { 110, 106 }, { 119, 123 }, { 138, 140 } };
    for (int i = 0; i < large.GetLength(0); i++) Save(Panel(large[i, 0], large[i, 1]), Path.Combine(dir, "wizard-large-" + i + ".bmp"));
    for (int i = 0; i < small.GetLength(0); i++) Save(Badge(small[i, 0], small[i, 1]), Path.Combine(dir, "wizard-small-" + i + ".bmp"));
  }

  static void Save(Bitmap bmp, string path) {
    using (bmp) bmp.Save(path, ImageFormat.Bmp);
  }

  /// The panel: the brand gradient, the logo in white and the name under it.
  static Bitmap Panel(int w, int h) {
    var bmp = new Bitmap(w, h, PixelFormat.Format24bppRgb);
    using (var g = Graphics.FromImage(bmp)) {
      g.SmoothingMode = SmoothingMode.AntiAlias;
      g.TextRenderingHint = System.Drawing.Text.TextRenderingHint.AntiAliasGridFit;
      using (var bg = new LinearGradientBrush(new PointF(0, 0), new PointF(w, h), Indigo, Cyan)) g.FillRectangle(bg, 0, 0, w, h);
      // Soft rings in the corners, as on the website.
      using (var ring = new Pen(Color.FromArgb(40, 255, 255, 255), w * 0.05f)) {
        g.DrawEllipse(ring, -w * 0.45f, -w * 0.35f, w * 1.0f, w * 1.0f);
        g.DrawEllipse(ring, w * 0.35f, h - w * 0.7f, w * 1.1f, w * 1.1f);
      }
      float logo = w * 0.46f;
      float x = (w - logo) / 2, y = h * 0.34f - logo / 2;
      using (var tile = RoundedRect(x, y, logo, logo, logo / 4)) g.FillPath(Brushes.White, tile);
      using (var z = new LinearGradientBrush(new PointF(x, y), new PointF(x + logo, y + logo), Indigo, Cyan)) DrawZ(g, z, x, y, logo);

      var center = new StringFormat { Alignment = StringAlignment.Center };
      using (var name = new Font("Segoe UI Semibold", w * 0.105f, GraphicsUnit.Pixel))
      using (var sub = new Font("Segoe UI", w * 0.075f, GraphicsUnit.Pixel))
      using (var soft = new SolidBrush(Color.FromArgb(225, 255, 255, 255))) {
        float ty = y + logo + w * 0.12f;
        g.DrawString("ZamTech AI", name, Brushes.White, new RectangleF(0, ty, w, name.Height * 1.5f), center);
        g.DrawString("Agent", sub, soft, new RectangleF(0, ty + name.Height * 1.25f, w, sub.Height * 1.5f), center);
      }
    }
    return bmp;
  }

  /// The small logo at the top right of the inner pages, on the page's white.
  static Bitmap Badge(int w, int h) {
    var bmp = new Bitmap(w, h, PixelFormat.Format24bppRgb);
    using (var g = Graphics.FromImage(bmp)) {
      g.SmoothingMode = SmoothingMode.AntiAlias;
      g.PixelOffsetMode = PixelOffsetMode.HighQuality;
      g.Clear(Color.White);
      float size = Math.Min(w, h) * 0.92f;
      float x = (w - size) / 2, y = (h - size) / 2;
      using (var tile = RoundedRect(x, y, size, size, size / 4))
      using (var bg = new LinearGradientBrush(new PointF(x, y), new PointF(x + size, y + size), Indigo, Cyan)) g.FillPath(bg, tile);
      DrawZ(g, Brushes.White, x, y, size);
    }
    return bmp;
  }

  /// The "Z" of the favicon (64x64 grid) in a square at x, y.
  static void DrawZ(Graphics g, Brush brush, float x, float y, float size) {
    float s = size / 64f;
    float[] pts = { 20, 20, 44, 20, 44, 25, 27, 40, 44, 40, 44, 44, 20, 44, 20, 39, 37, 24, 20, 24 };
    var z = new PointF[pts.Length / 2];
    for (int i = 0; i < z.Length; i++) z[i] = new PointF(x + pts[2 * i] * s, y + pts[2 * i + 1] * s);
    g.FillPolygon(brush, z);
  }

  static GraphicsPath RoundedRect(float x, float y, float w, float h, float r) {
    var p = new GraphicsPath();
    float d = r * 2;
    p.AddArc(x, y, d, d, 180, 90);
    p.AddArc(x + w - d, y, d, d, 270, 90);
    p.AddArc(x + w - d, y + h - d, d, d, 0, 90);
    p.AddArc(x, y + h - d, d, d, 90, 90);
    p.CloseFigure();
    return p;
  }
}
