const http = require('node:http');
const requestHandler = require('./lib/handler.js');

// This file is only for local dev; it must never export anything and must never
// start a server when loaded by Vercel (VERCEL env var set) or by static analysis.
if (require.main === module && !process.env.VERCEL) {
  const port = Number(process.env.PORT) || 4173;
  http.createServer(requestHandler).listen(port, () => console.log(`FurnishAR is running at http://localhost:${port}`));
}
