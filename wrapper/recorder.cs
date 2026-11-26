// Entomatical's Windows microphone recorder, the counterpart of arecord on Linux (src/voice.ts runs it).
// Records the default input device as 16 kHz mono 16-bit PCM with winmm's waveIn API (part of Windows) and writes it raw to
// stdout in 100 ms chunks until it is killed or stdout closes. Errors go to stderr with exit code 1.
// Built with the .NET Framework compiler that ships with Windows (C# 5); see wrapper\build.ps1.
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;

static class Recorder {
  [StructLayout(LayoutKind.Sequential)]
  struct WaveFormat { public ushort Tag, Channels; public uint Rate, BytesPerSecond; public ushort BlockAlign, Bits, Size; }
  [StructLayout(LayoutKind.Sequential)]
  struct WaveHeader { public IntPtr Data; public uint Length, Recorded; public IntPtr User; public uint Flags, Loops; public IntPtr Next, Reserved; }

  [DllImport("winmm.dll")] static extern int waveInOpen(out IntPtr handle, uint device, ref WaveFormat format, IntPtr callback, IntPtr instance, uint flags);
  [DllImport("winmm.dll")] static extern int waveInPrepareHeader(IntPtr handle, IntPtr header, int size);
  [DllImport("winmm.dll")] static extern int waveInAddBuffer(IntPtr handle, IntPtr header, int size);
  [DllImport("winmm.dll")] static extern int waveInStart(IntPtr handle);

  const uint WAVE_MAPPER = 0xFFFFFFFF; // the default recording device
  const uint WHDR_DONE = 1, WHDR_PREPARED = 2;
  const int CHUNK = 3200, BUFFERS = 8; // 100 ms each at 16 kHz mono 16-bit

  static int Fail(string what, int code) { Console.Error.WriteLine("Entomatical recorder: " + what + " failed (MMRESULT " + code + "). Is a microphone connected and allowed in Settings > Privacy > Microphone?"); return 1; }

  static int Main() {
    var fmt = new WaveFormat { Tag = 1, Channels = 1, Rate = 16000, BytesPerSecond = 32000, BlockAlign = 2, Bits = 16, Size = 0 };
    IntPtr wave;
    int r = waveInOpen(out wave, WAVE_MAPPER, ref fmt, IntPtr.Zero, IntPtr.Zero, 0); // CALLBACK_NULL: buffers are polled
    if (r != 0) return Fail("waveInOpen", r);
    int size = Marshal.SizeOf(typeof(WaveHeader));
    var headers = new IntPtr[BUFFERS];
    for (int i = 0; i < BUFFERS; i++) { // header and data in unmanaged memory: the driver writes into them
      headers[i] = Marshal.AllocHGlobal(size);
      Marshal.StructureToPtr(new WaveHeader { Data = Marshal.AllocHGlobal(CHUNK), Length = CHUNK }, headers[i], false);
      if ((r = waveInPrepareHeader(wave, headers[i], size)) != 0) return Fail("waveInPrepareHeader", r);
      if ((r = waveInAddBuffer(wave, headers[i], size)) != 0) return Fail("waveInAddBuffer", r);
    }
    if ((r = waveInStart(wave)) != 0) return Fail("waveInStart", r);
    var output = Console.OpenStandardOutput();
    var chunk = new byte[CHUNK];
    try {
      for (int i = 0; ; i = (i + 1) % BUFFERS) { // buffers come back in the order they were added
        var h = (WaveHeader)Marshal.PtrToStructure(headers[i], typeof(WaveHeader));
        while ((h.Flags & WHDR_DONE) == 0) { Thread.Sleep(10); h = (WaveHeader)Marshal.PtrToStructure(headers[i], typeof(WaveHeader)); }
        Marshal.Copy(h.Data, chunk, 0, (int)h.Recorded);
        output.Write(chunk, 0, (int)h.Recorded);
        output.Flush();
        h.Flags = WHDR_PREPARED; h.Recorded = 0;
        Marshal.StructureToPtr(h, headers[i], false);
        if ((r = waveInAddBuffer(wave, headers[i], size)) != 0) return Fail("waveInAddBuffer", r);
      }
    } catch (IOException) { return 0; } // Entomatical closed the pipe: done
  }
}
