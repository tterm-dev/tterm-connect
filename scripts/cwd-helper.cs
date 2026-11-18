// Prints the working folder of a process and of each of its direct children,
// one line each: pid <TAB> start time (FILETIME ticks) <TAB> folder. The shell
// comes first. Windows has no API for another process's working folder, so the
// helper reads it from the process's PEB (x64 layout). A process it cannot read
// (32-bit, protected, gone) prints an empty folder.
// index.js compiles this with the .NET Framework csc.exe on first use.
using System;
using System.Runtime.InteropServices;

static class CwdHelper {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct PROCESSENTRY32 {
    public uint dwSize, cntUsage, th32ProcessID;
    public IntPtr th32DefaultHeapID;
    public uint th32ModuleID, cntThreads, th32ParentProcessID;
    public int pcPriClassBase;
    public uint dwFlags;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string szExeFile;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct PROCESS_BASIC_INFORMATION {
    public IntPtr Reserved1, PebBaseAddress, Reserved2a, Reserved2b, UniqueProcessId, InheritedFrom;
  }

  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool Process32FirstW(IntPtr snap, ref PROCESSENTRY32 e);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool Process32NextW(IntPtr snap, ref PROCESSENTRY32 e);
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll")] static extern bool GetProcessTimes(IntPtr h, out long create, out long exit, out long kernel, out long user);
  [DllImport("kernel32.dll")] static extern bool IsWow64Process(IntPtr h, out bool wow64);
  [DllImport("kernel32.dll")] static extern bool ReadProcessMemory(IntPtr h, IntPtr addr, byte[] buf, IntPtr size, out IntPtr read);
  [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr h, int cls, ref PROCESS_BASIC_INFORMATION pbi, int size, out int len);

  const uint QUERY_INFORMATION = 0x0400, VM_READ = 0x0010, QUERY_LIMITED = 0x1000;

  static byte[] Read(IntPtr h, IntPtr addr, int size) {
    var buf = new byte[size];
    IntPtr got;
    if (!ReadProcessMemory(h, addr, buf, (IntPtr)size, out got) || (long)got != size) return null;
    return buf;
  }

  static long StartTime(uint pid) {
    IntPtr h = OpenProcess(QUERY_LIMITED, false, pid);
    if (h == IntPtr.Zero) return 0;
    long c, e, k, u;
    bool ok = GetProcessTimes(h, out c, out e, out k, out u);
    CloseHandle(h);
    return ok ? c : 0;
  }

  static string Cwd(uint pid) {
    IntPtr h = OpenProcess(QUERY_INFORMATION | VM_READ, false, pid);
    if (h == IntPtr.Zero) return "";
    try {
      bool wow64;
      if (IntPtr.Size != 8 || (IsWow64Process(h, out wow64) && wow64)) return "";
      var pbi = new PROCESS_BASIC_INFORMATION();
      int len;
      if (NtQueryInformationProcess(h, 0, ref pbi, Marshal.SizeOf(pbi), out len) != 0) return "";
      byte[] p = Read(h, pbi.PebBaseAddress + 0x20, 8);           // PEB.ProcessParameters
      if (p == null) return "";
      IntPtr parms = (IntPtr)BitConverter.ToInt64(p, 0);
      byte[] us = Read(h, parms + 0x38, 16);                       // CurrentDirectory.DosPath
      if (us == null) return "";
      int n = BitConverter.ToUInt16(us, 0);
      byte[] s = Read(h, (IntPtr)BitConverter.ToInt64(us, 8), n);
      if (s == null) return "";
      string dir = System.Text.Encoding.Unicode.GetString(s);
      return dir.Length > 3 ? dir.TrimEnd('\\') : dir;             // keep C:\ as is
    } finally { CloseHandle(h); }
  }

  static int Main(string[] args) {
    uint root;
    if (args.Length != 1 || !uint.TryParse(args[0], out root)) { Console.Error.WriteLine("usage: cwd-helper <pid>"); return 2; }
    long rootStart = StartTime(root);
    Console.WriteLine(root + "\t" + rootStart + "\t" + Cwd(root));
    IntPtr snap = CreateToolhelp32Snapshot(2, 0); // TH32CS_SNAPPROCESS
    if (snap == (IntPtr)(-1)) return 0;
    var e = new PROCESSENTRY32 { dwSize = (uint)Marshal.SizeOf(typeof(PROCESSENTRY32)) };
    for (bool more = Process32FirstW(snap, ref e); more; more = Process32NextW(snap, ref e)) {
      if (e.th32ParentProcessID != root || e.th32ProcessID == root) continue;
      long start = StartTime(e.th32ProcessID);
      // A reused parent pid: a "child" older than the shell is not its child.
      if (start != 0 && rootStart != 0 && start < rootStart) continue;
      Console.WriteLine(e.th32ProcessID + "\t" + start + "\t" + Cwd(e.th32ProcessID));
    }
    CloseHandle(snap);
    return 0;
  }
}
