Unicode true
!include "MUI2.nsh"
!include "FileFunc.nsh"
!include "LogicLib.nsh"
!include "x64.nsh"

Name "Hashrate Manager"
OutFile "${OUTPUT}"
InstallDir "$LOCALAPPDATA\Programs\Hashrate Manager"
InstallDirRegKey HKCU "Software\Hashrate Manager" "InstallDir"
RequestExecutionLevel user
SetCompressor /SOLID lzma
SetCompressorDictSize 64
SetDatablockOptimize on
ShowInstDetails show
ShowUninstDetails show
BrandingText "Hashrate Manager"
VIProductVersion "${VERSION}.0"
VIAddVersionKey /LANG=1046 "ProductName" "Hashrate Manager"
VIAddVersionKey /LANG=1046 "FileDescription" "Instalador do Hashrate Manager"
VIAddVersionKey /LANG=1046 "FileVersion" "${VERSION}"
VIAddVersionKey /LANG=1046 "ProductVersion" "${VERSION}"
VIAddVersionKey /LANG=1046 "LegalCopyright" "Hashrate Manager"

Var TestMode
!define REG_UNINSTALL "Software\Microsoft\Windows\CurrentVersion\Uninstall\HashrateManager"
!define MUI_ABORTWARNING
!define MUI_WELCOMEPAGE_TITLE "Instalar Hashrate Manager"
!define MUI_WELCOMEPAGE_TEXT "Acompanhe suas ordens e o resultado da arbitragem.$\r$\n$\r$\nEste instalador não inclui contas, sessões ou histórico de outra pessoa. Entre nas suas próprias contas depois da instalação."
!define MUI_FINISHPAGE_RUN "$INSTDIR\HashrateManager.exe"
!define MUI_FINISHPAGE_RUN_TEXT "Abrir Hashrate Manager"
!define MUI_FINISHPAGE_RUN_NOTCHECKED
!define MUI_FINISHPAGE_SHOWREADME "$INSTDIR\LEIA-ME.txt"
!define MUI_FINISHPAGE_SHOWREADME_TEXT "Ver instruções"
!define MUI_FINISHPAGE_SHOWREADME_NOTCHECKED
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "PortugueseBR"

Function .onInit
  SetShellVarContext current
  StrCpy $TestMode "0"
  ${GetParameters} $0
  ClearErrors
  ${GetOptions} $0 "/TESTMODE" $1
  ${IfNot} ${Errors}
    StrCpy $TestMode "1"
  ${EndIf}
  ${IfNot} ${RunningX64}
    MessageBox MB_OK|MB_ICONSTOP "Este aplicativo requer Windows de 64 bits."
    SetErrorLevel 2
    Abort
  ${EndIf}
FunctionEnd

; Never stop a running app or copy files over its executable.
!macro CheckApplicationClosed PREFIX
Function ${PREFIX}CheckApplicationClosed
  ${If} ${FileExists} "$INSTDIR\HashrateManager.exe"
    System::Call 'kernel32::CreateFileW(w "$INSTDIR\HashrateManager.exe", i 0x80000000, i 0, p 0, i 3, i 0, p 0) p.r0'
    ${If} $0 == -1
      MessageBox MB_OK|MB_ICONSTOP "Encerre o Hashrate Manager pela opção Sair na bandeja, perto do relógio, e tente novamente."
      SetErrorLevel 3
      Abort
    ${EndIf}
    System::Call 'kernel32::CloseHandle(p r0)'
  ${EndIf}
FunctionEnd
!macroend
!insertmacro CheckApplicationClosed ""
!insertmacro CheckApplicationClosed "un."

Section "Hashrate Manager"
  Call CheckApplicationClosed
  SetOverwrite on
  !include "${PAYLOAD_INCLUDE}"
  WriteUninstaller "$INSTDIR\Desinstalar.exe"
  ${If} $TestMode != "1"
    CreateDirectory "$SMPROGRAMS\Hashrate Manager"
    CreateShortcut "$SMPROGRAMS\Hashrate Manager\Hashrate Manager.lnk" "$INSTDIR\HashrateManager.exe" "" "$INSTDIR\HashrateManager.exe" 0
    CreateShortcut "$SMPROGRAMS\Hashrate Manager\Desinstalar.lnk" "$INSTDIR\Desinstalar.exe"
    CreateShortcut "$DESKTOP\Hashrate Manager.lnk" "$INSTDIR\HashrateManager.exe" "" "$INSTDIR\HashrateManager.exe" 0
    WriteRegStr HKCU "Software\Hashrate Manager" "InstallDir" "$INSTDIR"
    WriteRegStr HKCU "${REG_UNINSTALL}" "DisplayName" "Hashrate Manager"
    WriteRegStr HKCU "${REG_UNINSTALL}" "DisplayVersion" "${VERSION}"
    WriteRegStr HKCU "${REG_UNINSTALL}" "DisplayIcon" "$INSTDIR\HashrateManager.exe"
    WriteRegStr HKCU "${REG_UNINSTALL}" "InstallLocation" "$INSTDIR"
    WriteRegStr HKCU "${REG_UNINSTALL}" "UninstallString" '$\"$INSTDIR\Desinstalar.exe$\"'
    WriteRegStr HKCU "${REG_UNINSTALL}" "QuietUninstallString" '$\"$INSTDIR\Desinstalar.exe$\" /S'
    WriteRegDWORD HKCU "${REG_UNINSTALL}" "NoModify" 1
    WriteRegDWORD HKCU "${REG_UNINSTALL}" "NoRepair" 1
    WriteRegDWORD HKCU "${REG_UNINSTALL}" "EstimatedSize" ${INSTALLED_KB}
  ${EndIf}
SectionEnd

Function un.onInit
  SetShellVarContext current
  StrCpy $TestMode "0"
  ${GetParameters} $0
  ClearErrors
  ${GetOptions} $0 "/TESTMODE" $1
  ${IfNot} ${Errors}
    StrCpy $TestMode "1"
  ${EndIf}
FunctionEnd

Section "Uninstall"
  Call un.CheckApplicationClosed
  ; Only remove the files included in this installer. Preserve all user data.
  !include "${UNINSTALL_INCLUDE}"
  Delete "$INSTDIR\Desinstalar.exe"
  RMDir "$INSTDIR"
  ${If} $TestMode != "1"
    Delete "$SMPROGRAMS\Hashrate Manager\Hashrate Manager.lnk"
    Delete "$SMPROGRAMS\Hashrate Manager\Desinstalar.lnk"
    RMDir "$SMPROGRAMS\Hashrate Manager"
    Delete "$DESKTOP\Hashrate Manager.lnk"
    DeleteRegKey HKCU "${REG_UNINSTALL}"
    DeleteRegKey HKCU "Software\Hashrate Manager"
  ${EndIf}
SectionEnd