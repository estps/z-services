Copy-ZChatTray source + WebView2 assemblies next to exe
Build (run in PowerShell):
  1. Download Microsoft.Web.WebView2 nupkg from nuget.org, extract
  2. csc /nologo /target:winexe /platform:x64 /out:ZChat.exe /r:<pkg>\lib\net462\Microsoft.Web.WebView2.Core.dll /r:<pkg>\lib\net462\Microsoft.Web.WebView2.WinForms.dll /r:System.Windows.Forms.dll /r:System.Drawing.dll /r:Microsoft.CSharp.dll ZChatTray.cs
  3. Ship ZChat.exe + WebView2Loader.dll (runtimes\win-x64\native) + Microsoft.Web.WebView2.Core.dll + Microsoft.Web.WebView2.WinForms.dll together
Behavior: X hides to tray, double-click tray restores, Quit really exits. Single instance mutex. First run writes %LOCALAPPDATA%\ZChat\zchat.ico + Start Menu 'Z Chat.lnk'.
Installed at: C:\Users\charles\ZChat\ZChat.exe (Desktop + Start Menu shortcut).
