// Placeholder committed to git so this path exists in the pre-build tree --
// Vercel's function-to-route wiring requires the file to be present BEFORE
// buildCommand runs. Confirmed this session: a bracket/catch-all filename
// (api/[...path].js) deployed correctly as a function but was never
// invocable at any sub-path even after being committed pre-build --
// [...] doesn't appear to get parsed as a dynamic wildcard segment outside
// a framework that implements that convention itself. A plain, exact-match
// committed file (api/ping.js) DID route correctly, isolating the fix to:
// exact-match filename + pre-build presence + an explicit rewrite for
// sub-paths (see vercel.json's /api/:path* rewrite).
// vercel.json's buildCommand overwrites this file's real contents on every
// deploy (esbuild --bundle output of server/vercel-entry.ts).
export default function handler(req, res) {
  res.status(500).json({ message: "placeholder function -- build did not overwrite this file" });
}
