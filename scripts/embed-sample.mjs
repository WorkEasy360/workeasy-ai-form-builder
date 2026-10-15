// Serves infra/embed-sample/index.html on its own origin (default
// http://localhost:3002), so embedded forms can be checked from a host page
// that is not the respondent app. Development only.
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";

const port = Number(process.env.EMBED_SAMPLE_PORT ?? 3002);
const page = new URL("../infra/embed-sample/index.html", import.meta.url);

createServer(async (req, res) => {
  if (req.method !== "GET" || (req.url !== "/" && req.url !== "/index.html")) {
    res.writeHead(404, { "content-type": "text/plain" }).end("Not found");
    return;
  }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }).end(await readFile(page));
}).listen(port, "127.0.0.1", () => {
  console.log(`embed sample host: http://localhost:${port}`);
});
