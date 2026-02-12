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

echo [2/3] Building and starting standalone server...
call npm run standalone
if errorlevel 1 (
  echo [FAIL] Standalone launch failed.
  exit /b 1
)

echo [3/3] Done.
endlocal
