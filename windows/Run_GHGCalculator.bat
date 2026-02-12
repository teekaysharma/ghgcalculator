@echo off
setlocal EnableExtensions EnableDelayedExpansion

echo ==============================================
echo   GHG Calculator - Windows Launcher
echo ==============================================

cd /d "%~dp0.."
set "PROJECT_ROOT=%cd%"

echo Project root: %PROJECT_ROOT%
echo.

call "%~dp0Check_Prerequisites.bat"
if errorlevel 1 (
  echo.
  echo Prerequisite check failed. Please install/fix missing items and run again.
  exit /b 1
)

echo.
if not exist "%PROJECT_ROOT%\package.json" (
  echo [FAIL] package.json not found in %PROJECT_ROOT%
  echo        Please run this script from the extracted project folder.
  exit /b 1
)

if not exist "%PROJECT_ROOT%\node_modules" (
  echo [1/3] Installing npm dependencies...
  call npm install
  if errorlevel 1 (
    echo [FAIL] Dependency installation failed.
    exit /b 1
  )
) else (
  echo [1/3] node_modules found, skipping fresh install.
)

echo [2/3] Building production assets...
call npm run build
if errorlevel 1 (
  echo [FAIL] Build failed.
  exit /b 1
)

echo [3/3] Starting local server on http://localhost:5000
echo         Press Ctrl+C in this window to stop the server.
start "" "http://localhost:5000" >nul 2>&1
call npm start
if errorlevel 1 (
  echo [FAIL] Server failed to start.
  exit /b 1
)

endlocal
