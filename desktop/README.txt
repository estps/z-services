Z Chat desktop app (WebView2 tray app) - build & package notes
==============================================================

Source of truth: C:\Users\charles\.z-autopush\ZChatTray.cs  (mirrored here)

Build (run in PowerShell from this folder):
  1. WebView2 assemblies come from the Microsoft.Web.WebView2 nupkg
     (cached at C:\Users\charles\AppData\Local\Temp\opencode\wv2\pkg)
  2. csc.exe is the .NET Framework x64 compiler:
       C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe
     Command:
       csc /nologo /target:winexe /platform:x64 /out:ZChat.exe
           /win32manifest:app.manifest /win32icon:zchat.ico
           /r:<pkg>\lib\net462\Microsoft.Web.WebView2.Core.dll
           /r:<pkg>\lib\net462\Microsoft.Web.WebView2.WinForms.dll
           /r:System.Windows.Forms.dll /r:System.Drawing.dll /r:Microsoft.CSharp.dll
           ZChatTray.cs
  3. Ship together: ZChat.exe + ZChat.exe.config (WinForms PerMonitorV2 opt-in)
     + WebView2Loader.dll (pkg\runtimes\win-x64\native)
     + Microsoft.Web.WebView2.Core.dll + Microsoft.Web.WebView2.WinForms.dll (pkg\lib\net462)
     + zchat.ico (also embedded in the exe via /win32icon)

app.manifest: dpiAware true/PM + dpiAwareness PerMonitorV2, Win10/11 compatibility.
app.config  -> shipped as ZChat.exe.config, sets WinForms DpiAwareness=PerMonitorV2.

Installer (NSIS 3.10, portable copy of makensis.exe used):
  Build:  makensis.exe installer.nsi        ->  ZChatSetup.exe (v1.1.0)
  Payload sources live in .\payload\ (ZChat.exe, ZChat.exe.config, 3 DLLs, zchat.ico)
  Per-user install, no admin: $LOCALAPPDATA\Programs\ZChat
  Creates Start Menu "Z Chat.lnk" + optional Desktop shortcut, HKCU Apps & Features
  entry (Software\Microsoft\Windows\CurrentVersion\Uninstall\ZChat) + uninstall.exe.
  Kills a running ZChat.exe (taskkill) before overwriting.
  Silent install: ZChatSetup.exe /S
  Public URL: https://z-chat.men/media/downloads/ZChatSetup.exe

Behavior: X hides to tray, double-click tray restores, Quit really exits. Single
instance mutex. First run writes %LOCALAPPDATA%\ZChat\zchat.ico + Start Menu shortcut.
WebView2 user agent is appended with " ZChatDesktop/1.0" so the site can hide the
download button inside the app.

Portable copy kept at: C:\Users\charles\ZChat\ZChat.exe (Desktop .lnk points to the
installed copy under %LOCALAPPDATA%\Programs\ZChat since v1.1.0).
