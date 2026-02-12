@echo off
setlocal EnableExtensions EnableDelayedExpansion

echo ----------------------------------------------
echo Checking Windows prerequisites
echo ----------------------------------------------

where node >nul 2>&1
if errorlevel 1 goto :no_node

where npm >nul 2>&1
if errorlevel 1 goto :no_npm

for /f "usebackq delims=" %%v in (`node -p "process.versions.node" 2^>nul`) do set "NODE_VER=%%v"
for /f "tokens=1 delims=." %%v in ("!NODE_VER!") do set "NODE_MAJOR=%%v"

for /f "usebackq delims=" %%v in (`npm -v 2^>nul`) do set "NPM_VER=%%v"
for /f "tokens=1 delims=." %%v in ("!NPM_VER!") do set "NPM_MAJOR=%%v"

if not defined NODE_MAJOR goto :parse_fail
if not defined NPM_MAJOR goto :parse_fail

echo [INFO] Node.js version: !NODE_VER!
echo [INFO] npm version: !NPM_VER!

set /a NODE_MAJOR_NUM=!NODE_MAJOR! >nul 2>&1
if errorlevel 1 goto :parse_fail
set /a NPM_MAJOR_NUM=!NPM_MAJOR! >nul 2>&1
if errorlevel 1 goto :parse_fail

if !NODE_MAJOR_NUM! LSS 18 goto :bad_node
if !NPM_MAJOR_NUM! LSS 9 goto :bad_npm

where powershell >nul 2>&1
if errorlevel 1 (
  echo [WARN] PowerShell not found. Optional helper scripts may be unavailable.
) else (
  echo [OK] PowerShell detected.
)

echo [OK] Prerequisites look good for this tool.
exit /b 0

:no_node
echo [FAIL] Node.js is not installed or not on PATH.
echo        Install Node.js 18+ from https://nodejs.org/
exit /b 1

:no_npm
echo [FAIL] npm is not installed or not on PATH.
echo        Reinstall Node.js ^(npm is bundled with Node.js^).
exit /b 1

:bad_node
echo [FAIL] Node.js !NODE_VER! detected. Node.js 18+ is required.
exit /b 1

:bad_npm
echo [FAIL] npm !NPM_VER! detected. npm 9+ is required.
exit /b 1

:parse_fail
echo [FAIL] Could not parse Node.js/npm version values.
echo        Node.js output: !NODE_VER!
echo        npm output: !NPM_VER!
exit /b 1
