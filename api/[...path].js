// Placeholder committed to git so this path exists in the pre-build tree --
// Vercel's function-to-route wiring appears to require the file to be
// present BEFORE buildCommand runs (the same pre-build-tree scan already
// confirmed this session for vercel.json's `functions` glob validation).
// vercel.json's buildCommand overwrites this file's real contents on every
// deploy (esbuild --bundle output of server/vercel-entry.ts) -- this stub
// only needs to exist, never to run.
export default function handler(req, res) {
  res.status(500).json({ message: "placeholder function -- build did not overwrite this file" });
}
