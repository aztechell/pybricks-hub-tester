import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize, resolve } from "node:path";

const root = resolve(".");
const port = Number(process.env.PORT || 4173);

const mimeTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml"
};

function resolvePath(urlPath) {
  const requested = decodeURIComponent(new URL(urlPath, `http://localhost:${port}`).pathname);
  const normalized = normalize(requested).replace(/^([/\\])+/, "");
  const absolute = resolve(join(root, normalized || "index.html"));

  if (!absolute.startsWith(root)) {
    return null;
  }

  if (existsSync(absolute) && statSync(absolute).isDirectory()) {
    return join(absolute, "index.html");
  }

  return absolute;
}

createServer((request, response) => {
  const filePath = resolvePath(request.url || "/");

  if (!filePath || !existsSync(filePath)) {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Not found");
    return;
  }

  response.writeHead(200, {
    "Content-Type": mimeTypes[extname(filePath)] || "application/octet-stream"
  });
  createReadStream(filePath).pipe(response);
}).listen(port, () => {
  console.log(`Pybricks Hub Tester: http://localhost:${port}`);
});
