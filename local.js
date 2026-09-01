const http = require('node:http');
const requestHandler = require('./lib/handler.js');

if (!process.env.VERCEL) {
  const port = Number(process.env.PORT) || 4173;
  http.createServer(requestHandler).listen(port, () => console.log(`FurnishAR is running at http://localhost:${port}`));
}
