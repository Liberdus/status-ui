import http from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const PORT = Number(process.env.PORT || 4177);
const files = new Map([
  ["/", ["index.html", "text/html"]],
  ["/index.html", ["index.html", "text/html"]],
  ["/local-demo.html", ["local-demo.html", "text/html"]],
  ["/main.js", ["main.js", "text/javascript"]],
  ["/style.css", ["style.css", "text/css"]],
]);
const server = http.createServer(async (request, response) => {
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Cache-Control", "no-store");
  if (!["GET", "HEAD"].includes(request.method)) {
    response.writeHead(405); response.end(); return;
  }
  let pathname;
  try { pathname = new URL(request.url, "http://localhost").pathname; }
  catch { response.writeHead(400); response.end(); return; }
  const file = files.get(pathname);
  if (!file) { response.writeHead(404); response.end(); return; }
  try {
    const body = await readFile(fileURLToPath(new URL(file[0], import.meta.url)));
    response.writeHead(200, { "Content-Type": `${file[1]}; charset=utf-8` });
    response.end(request.method === "HEAD" ? undefined : body);
  } catch { response.writeHead(500); response.end("Asset unavailable"); }
});
server.listen(PORT, "127.0.0.1", () => {
  console.log(`Status UI at http://localhost:${server.address().port}`);
});
