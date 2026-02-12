@echo off
setlocal ENABLEDELAYEDEXPANSION

echo ----------------------------------------------
echo Checking Windows prerequisites

echo ----------------------------------------------

where node >nul 2>&1
if errorlevel 1 (
  echo [FAIL] Node.js is not installed or not on PATH.
  echo        Install Node.js 18 LTS or 20 LTS from https://nodejs.org/
  exit /b 1
)

where npm >nul 2>&1
if errorlevel 1 (
  echo [FAIL] npm is not installed or not on PATH.
  echo        Reinstall Node.js (npm is bundled with Node.js).
  exit /b 1
)

for /f "tokens=1,2 delims=." %%a in ('node -p "process.versions.node"') do (
  set NODE_MAJOR=%%a
  set NODE_MINOR=%%b
)

for /f "tokens=1,2 delims=." %%a in ('npm -v') do (
  set NPM_MAJOR=%%a
  set NPM_MINOR=%%b
)

echo [INFO] Node.js version: 
node -v

echo [INFO] npm version:
npm -v

if %NODE_MAJOR% LSS 18 (
  echo [FAIL] Node.js %NODE_MAJOR%.x detected. Node.js 18+ is required.
  exit /b 1
)

if %NODE_MAJOR% GEQ 23 (
  echo [FAIL] Node.js %NODE_MAJOR%.x detected. Supported range is ^>=18 ^<23.
  exit /b 1
)

if %NPM_MAJOR% LSS 9 (
  echo [FAIL] npm %NPM_MAJOR%.x detected. npm 9+ is required.
  exit /b 1
)

where powershell >nul 2>&1
if errorlevel 1 (
  echo [WARN] PowerShell not found. Optional helper scripts may be unavailable.
) else (
  echo [OK] PowerShell detected.
)

echo [OK] Prerequisites look good for this tool.
exit /b 0
