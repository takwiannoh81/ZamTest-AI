// Draws the ZamTech AI logo (apps/website/public/favicon.svg) into a Windows
// .ico with PNG frames. Used by scripts/build-installer.mjs:
//   IconGen.exe out.ico

using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;

static class IconGen {
  static int Main(string[] args) {
    if (args.Length != 1) {
      Console.Error.WriteLine("Usage: IconGen.exe out.ico");
      return 1;
    }
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
