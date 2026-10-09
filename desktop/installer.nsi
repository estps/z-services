; Z Chat per-user installer (no admin required)
; Build:  makensis.exe installer.nsi        (from z-services\desktop)
; Output: ZChatSetup.exe   Version 1.1.0

Unicode true

!include "MUI2.nsh"
!include "FileFunc.nsh"

!define APP_NAME        "Z Chat"
!define APP_EXE         "ZChat.exe"
!define APP_VERSION     "1.1.0"
!define APP_PUBLISHER   "Z Chat"
!define UNINST_KEY      "Software\Microsoft\Windows\CurrentVersion\Uninstall\ZChat"

Name "${APP_NAME}"
OutFile "ZChatSetup.exe"
InstallDir "$LOCALAPPDATA\Programs\ZChat"
InstallDirRegKey HKCU "${UNINST_KEY}" "InstallLocation"
RequestExecutionLevel user
SetCompressor /SOLID lzma
ShowInstDetails show
ShowUninstDetails show

VIProductVersion "1.1.0.0"
VIAddVersionKey /LANG=1033 "ProductName"     "${APP_NAME}"
VIAddVersionKey /LANG=1033 "FileDescription" "Z Chat installer"
VIAddVersionKey /LANG=1033 "FileVersion"     "${APP_VERSION}"
VIAddVersionKey /LANG=1033 "ProductVersion"  "${APP_VERSION}"
VIAddVersionKey /LANG=1033 "CompanyName"     "${APP_PUBLISHER}"
VIAddVersionKey /LANG=1033 "LegalCopyright"  "${APP_PUBLISHER}"

!define MUI_ICON   "zchat.ico"
!define MUI_UNICON "zchat.ico"
!define MUI_ABORTWARNING

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_COMPONENTS
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "English"

Function .onInit
  ; Close a running copy so its files can be overwritten.
  nsExec::Exec '"$SYSDIR\taskkill.exe" /IM ${APP_EXE} /F'
  Pop $0
FunctionEnd

Section "Z Chat application (required)" SecApp
  SectionIn RO
  SetShellVarContext current

  SetOutPath "$INSTDIR"
  File "payload\ZChat.exe"
  File "payload\ZChat.exe.config"
  File "payload\WebView2Loader.dll"
  File "payload\Microsoft.Web.WebView2.Core.dll"
  File "payload\Microsoft.Web.WebView2.WinForms.dll"
  File "payload\zchat.ico"

  WriteUninstaller "$INSTDIR\uninstall.exe"

  ; Start Menu shortcut named "Z Chat" -> Windows Search finds it.
  CreateDirectory "$SMPROGRAMS"
  CreateShortCut "$SMPROGRAMS\Z Chat.lnk" "$INSTDIR\${APP_EXE}" "" "$INSTDIR\zchat.ico" 0 \
    SW_SHOWNORMAL "" "Z Chat - calls ring in the background"

  ; Apps & Features entry (per-user).
  WriteRegStr   HKCU "${UNINST_KEY}" "DisplayName"          "${APP_NAME}"
  WriteRegStr   HKCU "${UNINST_KEY}" "DisplayVersion"       "${APP_VERSION}"
  WriteRegStr   HKCU "${UNINST_KEY}" "Publisher"            "${APP_PUBLISHER}"
  WriteRegStr   HKCU "${UNINST_KEY}" "DisplayIcon"          "$INSTDIR\zchat.ico"
  WriteRegStr   HKCU "${UNINST_KEY}" "InstallLocation"      "$INSTDIR"
  WriteRegStr   HKCU "${UNINST_KEY}" "UninstallString"      '"$INSTDIR\uninstall.exe"'
  WriteRegStr   HKCU "${UNINST_KEY}" "QuietUninstallString" '"$INSTDIR\uninstall.exe" /S'
  WriteRegDWORD HKCU "${UNINST_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINST_KEY}" "NoRepair" 1

  ${GetSize} "$INSTDIR" "/S=0K" $0 $1 $2
  WriteRegDWORD HKCU "${UNINST_KEY}" "EstimatedSize" "$0"
SectionEnd

Section /o "Desktop shortcut" SecDesktop
  SetShellVarContext current
  CreateShortCut "$DESKTOP\Z Chat.lnk" "$INSTDIR\${APP_EXE}" "" "$INSTDIR\zchat.ico" 0 \
    SW_SHOWNORMAL "" "Z Chat - calls ring in the background"
SectionEnd

!insertmacro MUI_FUNCTION_DESCRIPTION_BEGIN
  !insertmacro MUI_DESCRIPTION_TEXT ${SecApp}     "Z Chat tray app, WebView2 runtimes and icon (required)."
  !insertmacro MUI_DESCRIPTION_TEXT ${SecDesktop} "Also put a Z Chat shortcut on the Desktop."
!insertmacro MUI_FUNCTION_DESCRIPTION_END

Section "Uninstall"
  SetShellVarContext current

  nsExec::Exec '"$SYSDIR\taskkill.exe" /IM ${APP_EXE} /F'
  Pop $0

  Delete "$INSTDIR\ZChat.exe"
  Delete "$INSTDIR\ZChat.exe.config"
  Delete "$INSTDIR\WebView2Loader.dll"
  Delete "$INSTDIR\Microsoft.Web.WebView2.Core.dll"
  Delete "$INSTDIR\Microsoft.Web.WebView2.WinForms.dll"
  Delete "$INSTDIR\zchat.ico"
  Delete "$INSTDIR\uninstall.exe"
  RMDir "$INSTDIR"

  Delete "$SMPROGRAMS\Z Chat.lnk"
  Delete "$DESKTOP\Z Chat.lnk"

  ; Note: user data in $LOCALAPPDATA\ZChat (WebView2 profile, icon) is kept.
  DeleteRegKey HKCU "${UNINST_KEY}"
SectionEnd
