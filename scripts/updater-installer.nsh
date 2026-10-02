; Preserve the existing custom-installer directory on the first updater-capable install.
!macro customInit
  ReadRegStr $0 HKCU "Software\Hashrate Manager" "InstallDir"
  ${If} $0 != ""
    ${If} ${FileExists} "$0\HashrateManager.exe"
      StrCpy $INSTDIR $0
    ${EndIf}
  ${EndIf}
!macroend

; Retire only the legacy program registration; local profiles remain untouched.
!macro customInstall
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\HashrateManager"
  WriteRegStr HKCU "Software\Hashrate Manager" "InstallDir" "$INSTDIR"
!macroend
