# GHG Calculator — Standalone Local Setup Guide

This guide explains how to **download** and run the GHG Calculator as a standalone tool on your local machine (Windows/macOS/Linux).

---

## 1) Download the project

You can download the tool in either of these ways:

### Option A — Download ZIP (no Git required)
1. Open the repository page in your browser.
2. Click **Code** → **Download ZIP**.
3. Extract the ZIP to a folder, for example:
   - Windows: `C:\ghgcalculator`
   - macOS/Linux: `~/ghgcalculator`

### Option B — Clone with Git
```bash
git clone <REPOSITORY_URL>
cd ghgcalculator
```

> Replace `<REPOSITORY_URL>` with your repository URL.

---

## 2) Install prerequisites

- **Node.js 18 LTS or 20 LTS**
- **npm 9+** (installed with Node.js)

Check versions:

```bash
node -v
npm -v
```

---

## 3) Install dependencies

From the project root:

```bash
npm install
```

---

## 4) Run in development mode (recommended for first run)

```bash
npm run dev
```

Then open:

- `http://localhost:5000`

This runs the app locally with hot-reload.

---

## 5) Run as standalone local production build

Use the dedicated standalone script:

```bash
npm run standalone
```

What it does:
1. Builds the frontend and backend bundles
2. Starts the production server locally

Then open:

- `http://localhost:5000`

---


## Windows one-click launcher (recommended for end users)

This branch includes Windows helper scripts in `windows/`:

- `windows\Check_Prerequisites.bat` → validates Node.js/npm compatibility for this app
- `windows\Run_GHGCalculator.bat` → runs prerequisite checks, installs dependencies (if needed), then starts standalone mode

### Quick start on Windows
1. Download ZIP from the branch and extract it.
2. Double-click `windows\Run_GHGCalculator.bat`.
3. Wait for checks/build/start.
4. Open `http://localhost:5000` in your browser.

If prerequisites are missing, the script will show clear installation guidance.

---

## 6) Typical local workflow for emissions factors

1. Open the app in browser.
2. Upload factor files (`.xlsx`, `.xls`, `.csv`).
3. Upload additional files for different years (multi-year upload is supported).
4. Choose activities in scope tabs.
5. Run results and export CSV.

---

## 7) Troubleshooting

### Port already in use
If port `5000` is occupied, stop the other process and rerun:

```bash
npm run dev
```

### Clean reinstall
```bash
rm -rf node_modules package-lock.json
npm install
```

(Windows PowerShell)
```powershell
Remove-Item -Recurse -Force node_modules
Remove-Item -Force package-lock.json
npm install
```

### Build/type check
```bash
npm run check
npm run build
```

---

## 8) Local machine distribution (simple internal sharing)

To share with another local user:
1. Send this project folder (or ZIP).
2. Recipient runs:
   ```bash
   npm install
   npm run standalone
   ```
3. They open `http://localhost:5000`.

---

## 9) Script reference

- `npm run dev` → local development mode
- `npm run check` → TypeScript check
- `npm run build` → build frontend + backend
- `npm start` → run production server from `dist`
- `npm run standalone` → build + run production locally
