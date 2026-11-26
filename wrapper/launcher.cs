// Entomatical panel wrapper launcher for Windows (user setting claudeCode.claudeProcessWrapper).
// The extension runs: entomatical-claude.exe <path to claude.exe> <cli args...>
//
// The wrapper itself is entomatical-claude.js beside this file, the same one Linux runs; read its header for what it does.
// This only starts it with node, because Claude Code starts the wrapper as a program and Windows cannot start a .js file
// as one. stdin, stdout and stderr are inherited, so the stream passes straight between the extension and the script.
//
// It first puts itself in a kill-on-close job, so node, claude and everything they start end when the extension ends
// this process (for example when a panel closes). Node has no way to do that on its own.
// Built with the .NET Framework compiler that ships with Windows (C# 5); see wrapper\build.ps1.
using System;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;

static class Program
{
    static int Main(string[] argv)
    {
        KillChildrenWithMe();
        var script = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "entomatical-claude.js");
        var node = FindNode();
        if (node == null)
        {
            Console.Error.WriteLine("entomatical-claude: node.exe is not on PATH. Install Node.js, or run 'Entomatical: Use Terminal Instead'.");
            return 127;
        }
        var psi = new ProcessStartInfo(node, string.Join(" ", new[] { script }.Concat(argv).Select(Quote))) { UseShellExecute = false };
        using (var child = Process.Start(psi))
        {
            child.WaitForExit();
            return child.ExitCode;
        }
    }

    // Searched on PATH only, never in the current folder (a repo could hold its own node.exe). A relative entry (".", "bin",
    // "C:tools") would be read against the current folder, which is the task's repo, so only full paths count (review, 5 Nov 2026).
    static string FindNode()
    {
        foreach (var dir in (Environment.GetEnvironmentVariable("PATH") ?? "").Split(';'))
        {
            try
            {
                var d = dir.Trim().Trim('"');
                bool full = d.StartsWith(@"\\") || (d.Length >= 3 && char.IsLetter(d[0]) && d[1] == ':' && (d[2] == '\\' || d[2] == '/'));
                if (!full) continue;
                var exe = Path.Combine(d, "node.exe");
                if (File.Exists(exe)) return exe;
            }
            catch (ArgumentException) { } // a malformed PATH entry
        }
        return null;
    }

    // Windows command-line quoting, the inverse of CommandLineToArgvW.
    static string Quote(string a)
    {
        if (a.Length > 0 && a.IndexOfAny(new[] { ' ', '\t', '\n', '\v', '"' }) < 0) return a;
        var sb = new StringBuilder("\"");
        int slashes = 0;
        foreach (var c in a)
        {
            if (c == '\\') { slashes++; continue; }
            if (c == '"') sb.Append('\\', slashes * 2 + 1).Append('"');
            else sb.Append('\\', slashes).Append(c);
            slashes = 0;
        }
        sb.Append('\\', slashes * 2).Append('"');
        return sb.ToString();
    }

    // Kill-on-close job holding this process; children join it automatically.
    [StructLayout(LayoutKind.Sequential)]
    struct BasicLimits
    {
        public long PerProcessUserTimeLimit, PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass, SchedulingClass;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct IoCounters { public ulong R, W, O, RB, WB, OB; }
    [StructLayout(LayoutKind.Sequential)]
    struct ExtendedLimits
    {
        public BasicLimits Basic;
        public IoCounters Io;
        public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
    }
    [DllImport("kernel32.dll")] static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll")] static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref ExtendedLimits info, int length);
    [DllImport("kernel32.dll")] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
    static IntPtr job; // held open for the life of the process

    static void KillChildrenWithMe()
    {
        job = CreateJobObject(IntPtr.Zero, null);
        var info = new ExtendedLimits();
        info.Basic.LimitFlags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        if (job == IntPtr.Zero || !SetInformationJobObject(job, 9, ref info, Marshal.SizeOf(typeof(ExtendedLimits))) || !AssignProcessToJobObject(job, GetCurrentProcess()))
            Console.Error.WriteLine("entomatical-claude: could not set up the job object; child processes may outlive a closed panel");
    }
}
