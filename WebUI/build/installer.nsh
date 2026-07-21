!macro customHeader
  ShowInstDetails show
  ShowUninstDetails show
!macroend

!macro customInstallMode
    ; Both flags "0" lets the assisted installer show the install-mode page so a
    ; system administrator can install for all users (elevated) while a normal
    ; user can still install just for themselves (unelevated). Previously
    ; $isForceCurrentInstall was "1", which forced per-user and hid the choice.
    StrCpy $isForceCurrentInstall "0"
    StrCpy $isForceMachineInstall "0"
!macroend

!macro customInstall

    ReadRegDWORD $0 HKLM "SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64" "Installed"
    ${If} $0 != "1"
      DetailPrint "Installing Microsoft Visual C++ Redistributable..."
      inetc::get /CAPTION " " /BANNER "Downloading Microsoft Visual C++ Redistributable..." "https://aka.ms/vs/17/release/vc_redist.x64.exe" "$TEMP\vc_redist.x64.exe"
      ExecWait "$TEMP\vc_redist.x64.exe /install /norestart"
    ${EndIf}
      
    SetDetailsPrint both

    StrCpy $0 "$INSTDIR"
    StrCpy $1 "_model_backup"
    StrCpy $2 "$0$1"
    IfFileExists "$2" recoverModels end

    recoverModels:
      DetailPrint "Recovering model files..."
      nsExec::ExecToLog '"$INSTDIR\resources\uv.exe" "run" "--script" "$INSTDIR\resources\service\move_model_files.py" "$2" "$INSTDIR\resources\models"'
      Pop $0
      ${if} $0 == 0
        RMDir /r "$2"
        Goto end
      ${endIf}

      IfSilent +2
      MessageBox MB_OK "WARNING: Failed to recover model files from $2. You can manually copy the contents from $2 to $INSTDIR\resources\models"

    end:
        DetailPrint "Installation completed."

    ; --- AI Playground: all-users shared/per-user model folder choice ---
    ; Only all-users installs get a machine-wide config; a per-user
    ; (CurrentUser) install keeps the default per-user model paths and writes
    ; nothing here. Uses $R0-$R3 to avoid clobbering $0-$2 used above.
    ;   $R0 = %ProgramData%  $R1 = config dir  $R2 = shared models dir
    ;   $R3 = file handle     $R4 = folder-picker result
    ${if} $installMode != "CurrentUser"
      ReadEnvStr $R0 "ProgramData"
      ${if} $R0 == ""
        StrCpy $R0 "$PROGRAMFILES\..\..\ProgramData"
      ${endif}
      StrCpy $R1 "$R0\AI Playground"
      StrCpy $R2 "$R1\models"
      CreateDirectory "$R1"

      ; Default to shared (IDYES); silent installs auto-select it via /SD IDYES.
      MessageBox MB_YESNO|MB_ICONQUESTION \
        "Share downloaded AI models across all users of this computer?$\r$\n$\r$\nYes (recommended): one shared model folder used by everyone.$\r$\nNo: each user keeps a separate copy." \
        /SD IDYES IDYES aipgShared IDNO aipgPerUser

      aipgShared:
        ; Let the administrator choose where the shared models live (defaults to
        ; %ProgramData%\AI Playground\models). Skipped on silent installs, which
        ; keep the default. Uses the native "browse for folder" dialog.
        ${IfNot} ${Silent}
          nsDialogs::SelectFolderDialog "Choose the shared AI models folder (used by all users of this computer)" "$R2"
          Pop $R4
          ${If} $R4 != "error"
          ${AndIf} $R4 != ""
            StrCpy $R2 "$R4"
          ${EndIf}
        ${EndIf}
        CreateDirectory "$R2"
        ; Record the chosen path in a plain sidecar file (raw path — avoids
        ; JSON backslash-escaping in NSIS). The app reads it back and junctions
        ; <resources>\models to it (see electron/installConfig.ts).
        ClearErrors
        FileOpen $R3 "$R1\shared-model-dir.txt" w
        ${ifNot} ${errors}
          FileWrite $R3 "$R2"
          FileClose $R3
        ${endif}
        ClearErrors
        FileOpen $R3 "$R1\install-config.json" w
        ${ifNot} ${errors}
          FileWrite $R3 '{$\r$\n  "modelFolderMode": "shared"$\r$\n}$\r$\n'
          FileClose $R3
        ${endif}
        Goto aipgDone

      aipgPerUser:
        ; Drop any stale shared-folder path from a previous shared install.
        Delete "$R1\shared-model-dir.txt"
        ClearErrors
        FileOpen $R3 "$R1\install-config.json" w
        ${ifNot} ${errors}
          FileWrite $R3 '{$\r$\n  "modelFolderMode": "per-user"$\r$\n}$\r$\n'
          FileClose $R3
        ${endif}
        Goto aipgDone

      aipgDone:
    ${endif}

!macroend


!macro customRemoveFiles

  IfSilent keepModels
  SetDetailsPrint both
  DetailPrint "Uninstalling existing files..."

  ; Ask the user if they want to keep the models
  MessageBox MB_YESNO "Do you want to keep the models directory?" IDYES keepModels IDNO deleteAll


  keepModels:
    ; If the user clicked "Yes", move the models directory to a temporary location in the same drive, delete the installation directory, and then move back the models directory
    DetailPrint "Backing up model files..."

    StrCpy $0 "$INSTDIR"
    StrCpy $1 "_model_backup"
    StrCpy $2 "$0$1"

    IfFileExists "$INSTDIR\resources\uv.exe" 0 slowBackup
    IfFileExists "$INSTDIR\resources\service\move_model_files.py" 0 slowBackup
    nsExec::ExecToLog '"$INSTDIR\resources\uv.exe" "run" "--script" "$INSTDIR\resources\service\move_model_files.py" "$INSTDIR\resources\models" "$2"'
    Pop $0
    ${if} $0 == 0
      Goto deleteAll
    ${endIf}

  slowBackup:
    IfFileExists "$2" copyToBackup moveToBackup

  copyToBackup:
    CopyFiles "$INSTDIR\resources\service\models\*.*" "$2"
    DetailPrint "backup model directory at $2"
    Goto deleteAll

  moveToBackup:
    Rename "$INSTDIR\resources\models" "$2"
    DetailPrint "backup model directory at $2"

  deleteAll:
    ; If the user clicked "No", delete the entire installation directory
    DetailPrint "Removing existing files..."
    RMDir /r "$INSTDIR"

!macroend


!macro customUnInstall
  ; Remove only the machine-wide install marker so a future reinstall re-prompts
  ; for the model-folder choice. The shared models directory
  ; (%ProgramData%\AI Playground\models) and each user's per-user working tree
  ; (%LOCALAPPDATA%\ai-playground) are intentionally preserved — they may hold
  ; many GB of admin-provisioned models and cannot be safely enumerated for
  ; every user profile from a machine-wide uninstaller.
  ReadEnvStr $R0 "ProgramData"
  ${if} $R0 != ""
    Delete "$R0\AI Playground\install-config.json"
    Delete "$R0\AI Playground\shared-model-dir.txt"
  ${endif}
!macroend
