import { createApp } from "./app";
import { log } from "./vite";

(async () => {
  const { server } = await createApp();

  // ALWAYS serve the app on port 5000
  // this serves both the API and the client.
  // It is the only port that is not firewalled.
  const port = Number(process.env.PORT) || 5000;
  server.listen(
    {
      port,
      host: "0.0.0.0",
      // reusePort (SO_REUSEPORT) is a Linux socket option, inherited from
      // this app's original Replit/Linux environment. It is not supported
      // on Windows and throws ENOTSUP on listen() there, so it's disabled
      // on win32. Same fix already independently applied on the
      // `codex/review-code-for-gaps-and-improvements` branch.
      ...(process.platform !== "win32" ? { reusePort: true } : {}),
    },
    () => {
      log(`serving on port ${port}`);
    },
  );
})();
