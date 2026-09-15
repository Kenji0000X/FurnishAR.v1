const http = require('node:http');
const requestHandler = require('./lib/handler.js');

// Refuse to come up on the forgeable development secret. The check lives in
// the handler and is made explicitly here so a misconfigured deployment dies
// at startup rather than on the first sign-in attempt.
requestHandler.assertSigningSecret();

// This file is only for local dev; it must never export anything and must never
// start a server when loaded by Vercel (VERCEL env var set) or by static analysis.
if (require.main === module && !process.env.VERCEL) {
  const port = Number(process.env.PORT) || 4173;
  http.createServer(requestHandler).listen(port, () => console.log(`FurnishAR is running at http://localhost:${port}`));
}
