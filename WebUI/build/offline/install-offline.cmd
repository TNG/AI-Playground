@echo off
setlocal EnableExtensions
set "INSTDIR=%~1"
set "DEST=%~2"
if "%INSTDIR%"=="" (
  echo Usage: install-offline.cmd ^<install dir^> [resources dir]
  exit /b 1
)
if "%DEST%"=="" set "DEST=%INSTDIR%\resources"
if not exist "%INSTDIR%\resources\uv.exe" (
  echo uv.exe was not found at "%INSTDIR%\resources\uv.exe"
  exit /b 1
)
set "PAYLOAD=%~dp0"
set "UV=%INSTDIR%\resources\uv.exe"

reg query "HKLM\SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64" /v Installed 2>nul | find "0x1" >nul
if errorlevel 1 (
  if exist "%PAYLOAD%vc_redist.x64.exe" (
    echo Installing Microsoft Visual C++ Redistributable...
    "%PAYLOAD%vc_redist.x64.exe" /install /norestart
    if errorlevel 1 if not errorlevel 3010 exit /b 1
  )
)

if /I not "%DEST%"=="%INSTDIR%\resources" (
  echo Copying Python projects to "%DEST%"
  call :copyProject service || exit /b 1
  call :copyProject home-agent || exit /b 1
  call :copyProject OpenVINO || exit /b 1
  if not exist "%DEST%" mkdir "%DEST%"
  for %%F in (uv.exe uvw.exe uvx.exe 7zr.exe) do (
    if exist "%INSTDIR%\resources\%%F" copy /Y "%INSTDIR%\resources\%%F" "%DEST%\%%F" >nul
  )
)

echo Copying offline OpenVINO, model, and package cache...
call :mirror "%PAYLOAD%OpenVINO" "%DEST%\OpenVINO" || exit /b 1
call :mirror "%PAYLOAD%models" "%DEST%\models" || exit /b 1
call :mirror "%PAYLOAD%uv-cache" "%DEST%\uv-cache" || exit /b 1
if exist "%PAYLOAD%portable-git.7z.exe" copy /Y "%PAYLOAD%portable-git.7z.exe" "%DEST%\portable-git.7z.exe" >nul

set "UV_CACHE_DIR=%DEST%\uv-cache"
set "UV_PYTHON_INSTALL_DIR=%DEST%\python-interpreter"
set "UV_NO_ENV_FILE=1"
set "UV_NO_CONFIG=1"
set "UV_PYTHON_PREFERENCE=only-managed"

echo Installing Python 3.12 from the offline cache...
"%UV%" python install 3.12 --offline
if errorlevel 1 exit /b 1

call :syncProject service || exit /b 1
call :syncProject home-agent || exit /b 1
call :syncProject OpenVINO || exit /b 1
echo Offline setup finished.
exit /b 0

:copyProject
robocopy "%INSTDIR%\resources\%~1" "%DEST%\%~1" /E /XD .venv /NFL /NDL /NJH /NJS /nc /ns /np
if errorlevel 8 exit /b 1
exit /b 0

:mirror
if not exist "%~1\" exit /b 0
robocopy "%~1" "%~2" /E /NFL /NDL /NJH /NJS /nc /ns /np
if errorlevel 8 exit /b 1
exit /b 0

:syncProject
echo Creating the %~1 Python environment...
"%UV%" venv --directory "%DEST%" --project "%~1" --allow-existing --relocatable --offline
if errorlevel 1 exit /b 1
"%UV%" sync --directory "%DEST%" --project "%~1" --offline
if errorlevel 1 exit /b 1
exit /b 0
