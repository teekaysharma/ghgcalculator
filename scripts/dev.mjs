import { spawn } from "node:child_process";

const child = spawn(
  process.platform === "win32" ? "tsx.cmd" : "tsx",
  ["server/index.ts"],
  {
    stdio: "inherit",
    env: { ...process.env, NODE_ENV: "development" },
  },
);

child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 0);
});
