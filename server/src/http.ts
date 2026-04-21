import { IncomingMessage, ServerResponse, createServer, Server } from "http";
import { URL } from "url";
import { extname, join, normalize, resolve } from "path";
import { createReadStream, existsSync, statSync } from "fs";
import { readFile } from "fs/promises";

export interface AiosRequest extends IncomingMessage {
  path: string;
  query: Record<string, string>;
  body?: any;
  rawBody?: Buffer;
  params: Record<string, string>;
  session?: { id: string; userId: number; csrf: string } | null;
  actor?: { userId: number; email: string; isAdmin: boolean } | null;
}

export interface AiosResponse extends ServerResponse {
  json(body: unknown, status?: number): void;
  text(body: string, status?: number): void;
  error(status: number, message: string, extra?: Record<string, unknown>): void;
}

export type Handler = (req: AiosRequest, res: AiosResponse) => Promise<void> | void;

interface Route { method: string; pattern: RegExp; keys: string[]; handler: Handler; }

export class Router {
  private routes: Route[] = [];
  private middleware: Handler[] = [];

  use(fn: Handler) { this.middleware.push(fn); }

  add(method: string, path: string, handler: Handler) {
    const keys: string[] = [];
    const patternSource = path
      .replace(/:([A-Za-z_]\w*)/g, (_, k) => {
        keys.push(k);
        return "([^/]+)";
      })
      .replace(/\*/g, "(.*)");
    const pattern = new RegExp(`^${patternSource}/?$`);
    this.routes.push({ method: method.toUpperCase(), pattern, keys, handler });
  }

  get(p: string, h: Handler)    { this.add("GET", p, h); }
  post(p: string, h: Handler)   { this.add("POST", p, h); }
  put(p: string, h: Handler)    { this.add("PUT", p, h); }
  delete(p: string, h: Handler) { this.add("DELETE", p, h); }

  async handle(req: AiosRequest, res: AiosResponse): Promise<boolean> {
    for (const mw of this.middleware) {
      await mw(req, res);
      if (res.writableEnded) return true;
    }
    for (const r of this.routes) {
      if (r.method !== req.method) continue;
      const m = req.path.match(r.pattern);
      if (!m) continue;
      for (let i = 0; i < r.keys.length; i++) {
        req.params[r.keys[i]] = decodeURIComponent(m[i + 1]);
      }
      await r.handler(req, res);
      return true;
    }
    return false;
  }
}

export class HttpError extends Error {
  constructor(public status: number, message: string, public extra?: Record<string, unknown>) {
    super(message);
  }
}

export const badRequest = (m = "bad request", extra?: any) => new HttpError(400, m, extra);
export const unauthorized = (m = "unauthorized") => new HttpError(401, m);
export const forbidden = (m = "forbidden") => new HttpError(403, m);
export const notFound = (m = "not found") => new HttpError(404, m);
export const conflict = (m = "conflict") => new HttpError(409, m);

function decorate(res: ServerResponse): AiosResponse {
  const ares = res as AiosResponse;
  ares.json = (body, status = 200) => {
    if (!ares.headersSent) {
      ares.statusCode = status;
      ares.setHeader("Content-Type", "application/json");
    }
    ares.end(JSON.stringify(body));
  };
  ares.text = (body, status = 200) => {
    if (!ares.headersSent) {
      ares.statusCode = status;
      ares.setHeader("Content-Type", "text/plain; charset=utf-8");
    }
    ares.end(body);
  };
  ares.error = (status, message, extra) => {
    ares.json({ error: message, ...(extra || {}) }, status);
  };
  return ares;
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolveBody, rejectBody) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > 10 * 1024 * 1024) { // 10MB cap
        rejectBody(new HttpError(413, "payload too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolveBody(Buffer.concat(chunks)));
    req.on("error", rejectBody);
  });
}

// Paths where we skip body buffering so routes can stream the request
// directly (e.g. large file uploads). Matched against url.pathname.
const STREAMING_PATHS = [/^\/api\/departments\/[^/]+\/storage\/objects\/upload$/];

async function parseRequest(req: IncomingMessage): Promise<AiosRequest> {
  const areq = req as AiosRequest;
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  areq.path = url.pathname;
  areq.query = Object.fromEntries(url.searchParams.entries());
  areq.params = {};
  if (STREAMING_PATHS.some((r) => r.test(areq.path))) {
    areq.rawBody = undefined;
    areq.body = undefined;
    return areq;
  }
  const buf = await readBody(req);
  areq.rawBody = buf;
  const ct = (req.headers["content-type"] || "").toString();
  if (buf.length && ct.startsWith("application/json")) {
    try { areq.body = JSON.parse(buf.toString("utf-8")); }
    catch { throw new HttpError(400, "invalid JSON body"); }
  } else if (buf.length && ct.startsWith("application/x-www-form-urlencoded")) {
    areq.body = Object.fromEntries(new URLSearchParams(buf.toString("utf-8")));
  } else {
    areq.body = buf.length ? buf : undefined;
  }
  return areq;
}

export function createHttpServer(router: Router, opts: { uiDir?: string } = {}): Server {
  return createServer(async (req, res) => {
    const ares = decorate(res);
    let areq: AiosRequest;
    try {
      areq = await parseRequest(req);
    } catch (e: any) {
      const status = e instanceof HttpError ? e.status : 500;
      ares.error(status, e?.message || "request parse failed");
      return;
    }

    try {
      const handled = await router.handle(areq, ares);
      if (handled) return;
      // Fall through to static UI for non-API GET requests.
      if (req.method === "GET" && !areq.path.startsWith("/api/") && opts.uiDir) {
        await serveStatic(opts.uiDir, areq.path, ares);
        return;
      }
      if (!ares.writableEnded) ares.error(404, "not found");
    } catch (e: any) {
      if (e instanceof HttpError) {
        ares.error(e.status, e.message, e.extra);
      } else {
        console.error("[aios] unhandled error", e);
        if (!ares.writableEnded) ares.error(500, e?.message || "internal error");
      }
    }
  });
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js":   "application/javascript; charset=utf-8",
  ".mjs":  "application/javascript; charset=utf-8",
  ".css":  "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg":  "image/svg+xml",
  ".png":  "image/png",
  ".ico":  "image/x-icon",
  ".woff2":"font/woff2",
};

async function serveStatic(root: string, urlPath: string, res: AiosResponse) {
  const safe = normalize(urlPath).replace(/^([./\\])+/, "");
  const candidate = resolve(join(root, safe));
  const indexHtml = resolve(join(root, "index.html"));
  if (!candidate.startsWith(resolve(root))) {
    res.error(403, "forbidden"); return;
  }
  let target = candidate;
  if (!existsSync(target) || statSync(target).isDirectory()) {
    // SPA fallback — always serve index.html if UI build exists.
    if (existsSync(indexHtml)) target = indexHtml;
    else { res.error(404, "not found"); return; }
  }
  const ext = extname(target).toLowerCase();
  res.setHeader("Content-Type", MIME[ext] || "application/octet-stream");
  if (ext === ".html") res.setHeader("Cache-Control", "no-cache");
  createReadStream(target).pipe(res);
}

export async function readText(path: string): Promise<string | null> {
  try { return await readFile(path, "utf-8"); } catch { return null; }
}
