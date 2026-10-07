#!/usr/bin/env node
/* zbox MCP - a scoped Model Context Protocol server for the black box.

   Gives AI assistants (opencode, etc.) controlled access to the Z service
   stack: service status, logs, restarts (via polkit, NO sudo), and file
   operations strictly inside the Z services folders.

   Transport: MCP over Streamable HTTP (single /mcp endpoint, JSON-RPC 2.0).
   Auth: `Authorization: Bearer <ZB0X_MCP_TOKEN>` on every request.
   Runs as the `zchat` user with zero elevated privileges.

   Tools:
     zbox_health            quick everything-summary (services, disk, load)
     zbox_status            detailed service + system status
     zbox_logs              journalctl tail for a whitelisted unit
     zbox_restart_service   restart/start/stop a whitelisted unit (polkit)
     zbox_list_dir          list a directory inside the allowed roots
     zbox_read_file         read a text file inside the allowed roots
     zbox_write_file        write a text file inside the writable roots
*/

import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { execFile } from "node:child_process";

const PORT = Number(process.env.ZBOX_MCP_PORT || 8642);
const TOKEN = process.env.ZBOX_MCP_TOKEN || "";
const SERVER_NAME = "zbox";
const SERVER_VERSION = "1.0.0";
const PROTOCOL_VERSION = "2025-03-26";
const MAX_FILE_BYTES = 512 * 1024;
const MAX_READ_LINES = 800;
const MAX_LOG_LINES = 500;

if (!TOKEN) {
  console.error("[zbox-mcp] ZBOX_MCP_TOKEN is not set; refusing to start without auth");
  process.exit(1);
}

/* Units the assistant may inspect and (with polkit) control. */
const MANAGE_UNITS = new Set([
  "zchat-app.service",
  "zchat-deploy.timer",
  "zchat-deploy.service",
  "zgames.service",
  "zgames-mirror.timer",
  "zgames-heal.timer",
  "zslides.service",
  "zbox-mcp.service",
  "ollama.service",
]);

/* Directories the assistant may read / write. */
const READ_ROOTS = [
  "/srv/zslides",
  "/srv/zbox-mcp",
  "/srv/zservices",
  "/srv/zchat/state",
  "/srv/zgames/state",
  "/srv/zgames/site",
];
const WRITE_ROOTS = ["/srv/zslides", "/srv/zbox-mcp", "/srv/zservices"];

const READABLE_FILES = [
  "/srv/zchat/deploy.log",
  "/srv/zchat/health.log",
];

function run(command, args, timeoutMs = 15000) {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: timeoutMs, maxBuffer: 2 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({
        ok: !err,
        code: err && typeof err.code === "number" ? err.code : err ? 1 : 0,
        stdout: String(stdout || ""),
        stderr: String(stderr || ""),
      });
    });
  });
}

function inside(child, parent) {
  const resolvedChild = path.resolve(child);
  const resolvedParent = path.resolve(parent);
  return resolvedChild === resolvedParent || resolvedChild.startsWith(resolvedParent + path.sep);
}

function resolveAllowed(rawPath, roots) {
  const candidate = path.resolve(String(rawPath || ""));
  for (const root of roots) {
    if (inside(candidate, root)) return candidate;
  }
  return null;
}

function text(value) {
  return { content: [{ type: "text", text: String(value) }] };
}

function fail(value) {
  return { content: [{ type: "text", text: String(value) }], isError: true };
}

/* ---------------- tools ---------------- */

async function unitStates() {
  const units = [...MANAGE_UNITS];
  const results = await Promise.all(
    units.map(async (unit) => {
      const state = await run("systemctl", ["is-active", unit], 5000);
      return `${unit.padEnd(22)} ${state.stdout.trim() || "unknown"}`;
    })
  );
  return results.join("\n");
}

const TOOLS = {
  zbox_health: {
    description: "Quick health summary of the black box: service states, disk, load, memory, listening ports.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    async handler() {
      const [states, disk, load, mem, ports] = await Promise.all([
        unitStates(),
        run("df", ["-h", "/srv"]),
        run("uptime"),
        run("free", ["-m"]),
        run("ss", ["-ltn"], 5000),
      ]);
      const portList = ports.stdout
        .split("\n")
        .slice(1)
        .map((line) => line.trim().split(/\s+/).pop())
        .filter(Boolean)
        .slice(0, 30)
        .join(" ");
      return text(
        [
          "SERVICES",
          states,
          "",
          "LOAD",
          load.stdout.trim(),
          "",
          "MEMORY (MB)",
          mem.stdout,
          "",
          "DISK /srv",
          disk.stdout,
          "",
          "LISTENING PORTS",
          portList || "(none)",
        ].join("\n")
      );
    },
  },

  zbox_status: {
    description: "Detailed status of whitelisted Z services (state, restart count, memory).",
    inputSchema: { type: "object", properties: { unit: { type: "string", description: "optional single unit to detail" } }, additionalProperties: false },
    async handler(args) {
      const requested = args && args.unit ? String(args.unit) : "";
      const units = requested ? [requested] : [...MANAGE_UNITS];
      const chunks = [];
      for (const unit of units) {
        const show = await run("systemctl", ["show", unit, "--property=ActiveState,SubState,NRestarts,MemoryCurrent,ExecMainStartTimestamp"], 5000);
        chunks.push(`== ${unit}\n${show.stdout.trim() || show.stderr.trim()}`);
      }
      return text(chunks.join("\n\n"));
    },
  },

  zbox_logs: {
    description: "Tail logs for a whitelisted unit via journalctl (read-only).",
    inputSchema: {
      type: "object",
      properties: {
        unit: { type: "string", description: "unit name, e.g. zgames.service" },
        lines: { type: "number", description: `how many lines (max ${MAX_LOG_LINES})` },
      },
      required: ["unit"],
      additionalProperties: false,
    },
    async handler(args) {
      const unit = String(args.unit || "");
      if (!MANAGE_UNITS.has(unit)) return fail(`unit not allowed: ${unit}`);
      const lines = Math.max(1, Math.min(MAX_LOG_LINES, Number(args.lines) || 120));
      const result = await run("journalctl", ["-u", unit, "-n", String(lines), "--no-pager", "-o", "short-iso"], 20000);
      if (result.ok) return text(result.stdout || "(no log output)");
      return fail(`journalctl failed (${result.stderr.trim() || "unknown"}). If this is a permissions issue the service user may need the systemd-journal group.`);
    },
  },

  zbox_restart_service: {
    description: "Restart/start/stop/reload a whitelisted service. Uses polkit; no sudo. Timers are restarted too.",
    inputSchema: {
      type: "object",
      properties: {
        unit: { type: "string", description: "unit name, e.g. zgames.service" },
        action: { type: "string", enum: ["restart", "start", "stop", "reload"], description: "default restart" },
      },
      required: ["unit"],
      additionalProperties: false,
    },
    async handler(args) {
      const unit = String(args.unit || "");
      const action = String(args.action || "restart");
      if (!MANAGE_UNITS.has(unit)) return fail(`unit not allowed: ${unit}`);
      if (!["restart", "start", "stop", "reload"].includes(action)) return fail(`action not allowed: ${action}`);
      /* Self-management special case: stopping this service would take the MCP
         down for good, and a blocking restart kills the systemctl process mid-
         command (systemd stops our cgroup), so queue the job without blocking
         and let the response flush before the service cycles. */
      if (unit === "zbox-mcp.service") {
        if (action === "stop") {
          return fail("cannot stop zbox-mcp.service through the MCP - it would not come back");
        }
        /* Fire-and-forget: give the job a moment to reach systemd, then answer
           before the service cycles (the cycle kills this process, so waiting
           on systemctl here would always lose the race). */
        execFile("systemctl", ["--no-block", action, unit], { timeout: 10000 }, () => {});
        await new Promise((resolve) => setTimeout(resolve, 300));
        return text(`${action} ${unit} queued - this MCP is restarting itself; it will be back in a few seconds.`);
      }
      const result = await run("systemctl", [action, unit], 30000);
      if (result.ok) {
        const state = await run("systemctl", ["is-active", unit], 5000);
        return text(`${action} ${unit} -> ${state.stdout.trim() || "done"}`);
      }
      return fail(`${action} ${unit} failed: ${result.stderr.trim() || result.stdout.trim() || "unknown error (polkit policy may not cover this unit)"}`);
    },
  },

  zbox_list_dir: {
    description: "List a directory inside the allowed Z service roots.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string", description: "absolute path inside /srv/zslides, /srv/zbox-mcp, /srv/zservices, /srv/zchat/state, /srv/zgames/state or /srv/zgames/site" } },
      required: ["path"],
      additionalProperties: false,
    },
    async handler(args) {
      const target = resolveAllowed(args.path, READ_ROOTS);
      if (!target) return fail("path is outside the allowed roots");
      try {
        const entries = await fs.readdir(target, { withFileTypes: true });
        const lines = entries
          .sort((a, b) => a.name.localeCompare(b.name))
          .slice(0, 400)
          .map((entry) => (entry.isDirectory() ? "[dir]  " : "[file] ") + entry.name);
        return text(lines.join("\n") || "(empty)");
      } catch (err) {
        return fail(`cannot list: ${err.code || err.message}`);
      }
    },
  },

  zbox_read_file: {
    description: "Read a text file inside the allowed roots (or the zchat deploy/health logs).",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        max_lines: { type: "number", description: `tail at most this many lines (max ${MAX_READ_LINES})` },
      },
      required: ["path"],
      additionalProperties: false,
    },
    async handler(args) {
      const raw = String(args.path || "");
      let target = resolveAllowed(raw, READ_ROOTS);
      if (!target && READABLE_FILES.includes(path.resolve(raw))) target = path.resolve(raw);
      if (!target) return fail("path is outside the allowed roots");
      try {
        const stat = await fs.stat(target);
        if (!stat.isFile()) return fail("not a regular file");
        if (stat.size > MAX_FILE_BYTES) return fail(`file too large (${stat.size} bytes; max ${MAX_FILE_BYTES})`);
        let content = await fs.readFile(target, "utf8");
        const lines = content.split("\n");
        if (lines.length > MAX_READ_LINES) content = lines.slice(-MAX_READ_LINES).join("\n") + "\n...(truncated to last " + MAX_READ_LINES + " lines)";
        return text(content || "(empty file)");
      } catch (err) {
        return fail(`cannot read: ${err.code || err.message}`);
      }
    },
  },

  zbox_write_file: {
    description: "Write a text file inside the writable roots (/srv/zslides, /srv/zbox-mcp, /srv/zservices).",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" },
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
    async handler(args) {
      const target = resolveAllowed(args.path, WRITE_ROOTS);
      if (!target) return fail("path is outside the writable roots");
      const content = String(args.content || "");
      if (Buffer.byteLength(content, "utf8") > MAX_FILE_BYTES) return fail("content too large");
      try {
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, content, "utf8");
        return text(`wrote ${Buffer.byteLength(content, "utf8")} bytes to ${target}`);
      } catch (err) {
        return fail(`cannot write: ${err.code || err.message}`);
      }
    },
  },
};

/* ---------------- JSON-RPC / MCP ---------------- */

function rpcResult(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function rpcError(id, code, message) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

async function handleMessage(message) {
  if (!message || typeof message !== "object" || message.jsonrpc !== "2.0") {
    return rpcError(message && message.id != null ? message.id : null, -32600, "Invalid Request");
  }
  const { id, method, params } = message;
  const isNotification = id === undefined || id === null;

  if (method === "initialize") {
    return rpcResult(id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      instructions:
        "Scoped access to the black box Z services. Tools: zbox_health, zbox_status, zbox_logs, zbox_restart_service, zbox_list_dir, zbox_read_file, zbox_write_file. No sudo; file access is limited to the Z service folders.",
    });
  }
  if (method === "notifications/initialized" || method === "notifications/cancelled" || (isNotification && method)) {
    return null; // notifications get no reply
  }
  if (method === "ping") {
    return rpcResult(id, {});
  }
  if (method === "tools/list") {
    return rpcResult(id, {
      tools: Object.entries(TOOLS).map(([name, tool]) => ({
        name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      })),
    });
  }
  if (method === "tools/call") {
    const name = params && params.name;
    const tool = TOOLS[name];
    if (!tool) return rpcResult(id, fail(`unknown tool: ${name}`));
    try {
      const result = await tool.handler(params.arguments || {});
      return rpcResult(id, result);
    } catch (err) {
      return rpcResult(id, fail(`tool crashed: ${err.message || err}`));
    }
  }
  if (isNotification) return null;
  return rpcError(id, -32601, `Method not found: ${method}`);
}

function timingSafeMatch(provided, expected) {
  const a = Buffer.from(String(provided));
  const b = Buffer.from(String(expected));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", "http://localhost");
  if (url.pathname === "/healthz") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    return res.end("ok");
  }
  if (url.pathname !== "/mcp") {
    res.writeHead(404, { "Content-Type": "text/plain" });
    return res.end("Not found");
  }
  const auth = String(req.headers.authorization || "");
  const bearer = /^Bearer\s+(.+)$/i.exec(auth);
  if (!bearer || !timingSafeMatch(bearer[1], TOKEN)) {
    res.writeHead(401, { "Content-Type": "application/json", "WWW-Authenticate": "Bearer" });
    return res.end(JSON.stringify({ error: "unauthorized" }));
  }

  if (req.method === "GET") {
    // No server-initiated stream; tell clients clearly.
    res.writeHead(405, { "Content-Type": "application/json", Allow: "POST" });
    return res.end(JSON.stringify({ error: "use POST for MCP messages" }));
  }
  if (req.method !== "POST") {
    res.writeHead(405, { "Content-Type": "application/json", Allow: "POST" });
    return res.end(JSON.stringify({ error: "method not allowed" }));
  }

  let raw = "";
  req.on("data", (chunk) => {
    raw += chunk;
    if (raw.length > 1024 * 1024) req.destroy();
  });
  req.on("end", async () => {
    let payload;
    try {
      payload = JSON.parse(raw || "null");
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      return res.end(JSON.stringify(rpcError(null, -32700, "Parse error")));
    }
    const respond = (body) => {
      const data = JSON.stringify(body);
      res.writeHead(200, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) });
      res.end(data);
    };
    try {
      if (Array.isArray(payload)) {
        const results = [];
        for (const message of payload) {
          const result = await handleMessage(message);
          if (result) results.push(result);
        }
        if (!results.length) {
          res.writeHead(202);
          return res.end();
        }
        return respond(results);
      }
      const result = await handleMessage(payload);
      if (!result) {
        res.writeHead(202);
        return res.end();
      }
      respond(result);
    } catch (err) {
      console.error("[zbox-mcp] handler crashed:", err);
      respond(rpcError(payload && payload.id != null ? payload.id : null, -32603, "Internal error"));
    }
  });
});

server.listen(PORT, () => {
  console.log(`[zbox-mcp] listening on :${PORT} (tools: ${Object.keys(TOOLS).join(", ")})`);
});

process.on("SIGINT", () => server.close(() => process.exit(0)));
process.on("SIGTERM", () => server.close(() => process.exit(0)));
