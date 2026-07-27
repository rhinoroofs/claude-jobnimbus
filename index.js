/**
 * JobNimbus MCP Server
 * -----------------------------------------------------------------------
 * Wraps the JobNimbus REST API (https://app.jobnimbus.com/api1) as an MCP
 * server so Claude can read and write Jobs, Contacts, Tasks, and Estimates.
 *
 * IMPORTANT: JobNimbus's exact field names/endpoints can vary by account
 * config (custom fields, record types). Endpoints below reflect JobNimbus's
 * documented API1 structure as of general knowledge, but you MUST verify
 * against your account's live API docs at:
 *   https://app.jobnimbus.com  ->  Settings -> API
 * and adjust paths/fields if anything 404s or fields look different.
 * -----------------------------------------------------------------------
 */

import express from "express";
import fetch from "node-fetch";
import dotenv from "dotenv";
import crypto from "crypto";
import jwt from "jsonwebtoken";
import {
  McpServer,
} from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

dotenv.config();

const JOBNIMBUS_BASE_URL = "https://app.jobnimbus.com/api1";
const JOBNIMBUS_API_KEY = process.env.JOBNIMBUS_API_KEY;

if (!JOBNIMBUS_API_KEY) {
  console.error(
    "FATAL: JOBNIMBUS_API_KEY is not set. Add it to your environment before starting the server."
  );
  process.exit(1);
}

// -----------------------------------------------------------------------
// Minimal OAuth 2.1 (authorization code + PKCE) layer.
//
// Claude's custom connector "Individual sign-in" flow requires the target
// server to speak OAuth — it does a browser redirect to /authorize and
// then exchanges a code at /token. This server has no real "users," so it
// auto-approves any request from the registered client and issues signed,
// stateless JWTs as access/refresh tokens. Under the hood, every MCP call
// still just uses your single JOBNIMBUS_API_KEY.
// -----------------------------------------------------------------------
const OAUTH_CLIENT_ID = process.env.OAUTH_CLIENT_ID;
const OAUTH_CLIENT_SECRET = process.env.OAUTH_CLIENT_SECRET;
const OAUTH_SIGNING_SECRET = process.env.OAUTH_SIGNING_SECRET;

if (!OAUTH_CLIENT_ID || !OAUTH_CLIENT_SECRET || !OAUTH_SIGNING_SECRET) {
  console.error(
    "FATAL: OAUTH_CLIENT_ID, OAUTH_CLIENT_SECRET, and OAUTH_SIGNING_SECRET must all be set."
  );
  process.exit(1);
}

// In-memory store for short-lived authorization codes (a few minutes old,
// single-instance server — fine for this use case).
const authCodes = new Map(); // code -> { redirectUri, codeChallenge, codeChallengeMethod, expiresAt }

function issueAccessToken() {
  return jwt.sign({ type: "access" }, OAUTH_SIGNING_SECRET, { expiresIn: "30d" });
}
function issueRefreshToken() {
  return jwt.sign({ type: "refresh" }, OAUTH_SIGNING_SECRET, { expiresIn: "180d" });
}
function verifyAccessToken(token) {
  const payload = jwt.verify(token, OAUTH_SIGNING_SECRET);
  if (payload.type !== "access") throw new Error("Wrong token type");
  return payload;
}

/** Low-level helper for all JobNimbus REST calls */
async function jobNimbusRequest(path, { method = "GET", body, query } = {}) {
  let url = `${JOBNIMBUS_BASE_URL}${path}`;
  if (query && Object.keys(query).length > 0) {
    const params = new URLSearchParams(
      Object.entries(query).filter(([, v]) => v !== undefined && v !== null)
    );
    url += `?${params.toString()}`;
  }

  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${JOBNIMBUS_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  let parsed;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = { raw: text };
  }

  if (!res.ok) {
    throw new Error(
      `JobNimbus API error ${res.status} ${res.statusText}: ${JSON.stringify(
        parsed
      )}`
    );
  }
  return parsed;
}

/** Build the MCP server and register tools */
function buildServer() {
  const server = new McpServer({
    name: "jobnimbus-mcp",
    version: "1.0.0",
  });

  // ---------- JOBS ----------
  server.registerTool(
    "jobnimbus_list_jobs",
    {
      title: "List JobNimbus Jobs",
      description:
        "List/search jobs in JobNimbus. Supports free-text search and pagination.",
      inputSchema: {
        query: z
          .string()
          .optional()
          .describe("Free-text search term (e.g. customer name, address)."),
        status: z.string().optional().describe("Filter by job status name."),
        size: z
          .number()
          .optional()
          .describe("Number of results to return (default 25, max ~100)."),
        from: z
          .number()
          .optional()
          .describe("Pagination offset. Default 0."),
      },
    },
    async ({ query, status, size = 25, from = 0 }) => {
      const data = await jobNimbusRequest("/jobs", {
        query: { q: query, status, size, from },
      });
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
      };
    }
  );

  server.registerTool(
    "jobnimbus_get_job",
    {
      title: "Get JobNimbus Job",
      description: "Fetch a single job by its JobNimbus record JNID.",
      inputSchema: {
        jnid: z.string().describe("The JobNimbus record ID (jnid) of the job."),
      },
    },
    async ({ jnid }) => {
      const data = await jobNimbusRequest(`/jobs/${jnid}`);
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
      };
    }
  );

  server.registerTool(
    "jobnimbus_create_job",
    {
      title: "Create JobNimbus Job",
      description:
        "Create a new job/work order in JobNimbus. Pass any additional JobNimbus fields via extraFields if needed (e.g. custom fields specific to Rhino's account).",
      inputSchema: {
        display_name: z.string().describe("Job/customer display name."),
        address_line1: z.string().optional(),
        city: z.string().optional(),
        state_text: z.string().optional(),
        zip: z.string().optional(),
        status_name: z.string().optional().describe("Initial status, e.g. 'Sold'."),
        sales_rep: z.string().optional().describe("Assigned sales rep name or ID."),
        description: z.string().optional(),
        extraFields: z
          .record(z.any())
          .optional()
          .describe("Any additional raw JobNimbus fields to include as-is."),
      },
    },
    async ({ extraFields, ...fields }) => {
      const body = { ...fields, ...(extraFields || {}) };
      const data = await jobNimbusRequest("/jobs", { method: "PUT", body });
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
      };
    }
  );

  server.registerTool(
    "jobnimbus_update_job",
    {
      title: "Update JobNimbus Job",
      description:
        "Update fields on an existing job (e.g. change status, add notes, update address).",
      inputSchema: {
        jnid: z.string().describe("The JobNimbus record ID (jnid) of the job to update."),
        fields: z
          .record(z.any())
          .describe("Key/value fields to update, e.g. { status_name: 'Completed' }"),
      },
    },
    async ({ jnid, fields }) => {
      const data = await jobNimbusRequest(`/jobs/${jnid}`, {
        method: "POST",
        body: fields,
      });
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
      };
    }
  );

  // ---------- CONTACTS ----------
  server.registerTool(
    "jobnimbus_list_contacts",
    {
      title: "List JobNimbus Contacts",
      description: "List/search contacts (customers/leads) in JobNimbus.",
      inputSchema: {
        query: z.string().optional().describe("Free-text search term."),
        size: z.number().optional().describe("Number of results (default 25)."),
        from: z.number().optional().describe("Pagination offset. Default 0."),
      },
    },
    async ({ query, size = 25, from = 0 }) => {
      const data = await jobNimbusRequest("/contacts", {
        query: { q: query, size, from },
      });
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
      };
    }
  );

  server.registerTool(
    "jobnimbus_create_contact",
    {
      title: "Create JobNimbus Contact",
      description: "Create a new contact/lead record in JobNimbus.",
      inputSchema: {
        first_name: z.string().optional(),
        last_name: z.string().optional(),
        display_name: z.string().optional(),
        email: z.string().optional(),
        home_phone: z.string().optional(),
        mobile_phone: z.string().optional(),
        address_line1: z.string().optional(),
        city: z.string().optional(),
        state_text: z.string().optional(),
        zip: z.string().optional(),
        extraFields: z.record(z.any()).optional(),
      },
    },
    async ({ extraFields, ...fields }) => {
      const body = { ...fields, ...(extraFields || {}) };
      const data = await jobNimbusRequest("/contacts", { method: "PUT", body });
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
      };
    }
  );

  // ---------- TASKS ----------
  server.registerTool(
    "jobnimbus_list_tasks",
    {
      title: "List JobNimbus Tasks",
      description: "List tasks, optionally filtered by related job/contact.",
      inputSchema: {
        related_to: z
          .string()
          .optional()
          .describe("jnid of a job or contact to filter tasks for."),
        size: z.number().optional(),
        from: z.number().optional(),
      },
    },
    async ({ related_to, size = 25, from = 0 }) => {
      const data = await jobNimbusRequest("/tasks", {
        query: { related: related_to, size, from },
      });
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
      };
    }
  );

  server.registerTool(
    "jobnimbus_create_task",
    {
      title: "Create JobNimbus Task",
      description: "Create a task/reminder, optionally linked to a job or contact.",
      inputSchema: {
        title: z.string().describe("Task title/summary."),
        related_jnid: z
          .string()
          .optional()
          .describe("jnid of the job or contact this task relates to."),
        due_date: z.string().optional().describe("ISO date string for due date."),
        notes: z.string().optional(),
        assigned_to: z.string().optional().describe("Name or user ID to assign to."),
        extraFields: z.record(z.any()).optional(),
      },
    },
    async ({ extraFields, related_jnid, ...fields }) => {
      const body = {
        ...fields,
        ...(related_jnid ? { related: [related_jnid] } : {}),
        ...(extraFields || {}),
      };
      const data = await jobNimbusRequest("/tasks", { method: "PUT", body });
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
      };
    }
  );

  // ---------- ESTIMATES ----------
  server.registerTool(
    "jobnimbus_list_estimates",
    {
      title: "List JobNimbus Estimates",
      description: "List estimates, optionally filtered by related job.",
      inputSchema: {
        related_to: z.string().optional().describe("jnid of a job to filter estimates for."),
        size: z.number().optional(),
        from: z.number().optional(),
      },
    },
    async ({ related_to, size = 25, from = 0 }) => {
      const data = await jobNimbusRequest("/estimates", {
        query: { related: related_to, size, from },
      });
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
      };
    }
  );

  return server;
}

// -----------------------------------------------------------------------
// Express app hosting the MCP server over Streamable HTTP transport, plus
// the OAuth endpoints Claude's connector flow needs.
// -----------------------------------------------------------------------
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Tell OAuth-aware clients (like Claude) where the auth endpoints live.
app.get("/.well-known/oauth-authorization-server", (req, res) => {
  const base = `${req.protocol}://${req.get("host")}`;
  res.json({
    issuer: base,
    authorization_endpoint: `${base}/authorize`,
    token_endpoint: `${base}/token`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["client_secret_post", "client_secret_basic"],
  });
});

app.get("/.well-known/oauth-protected-resource", (req, res) => {
  const base = `${req.protocol}://${req.get("host")}`;
  res.json({
    resource: `${base}/mcp`,
    authorization_servers: [base],
  });
});

// Step 1 of the OAuth dance: Claude's browser gets redirected here. Since
// this server has exactly one "user" (you), we auto-approve immediately
// instead of showing a login page.
app.get("/authorize", (req, res) => {
  const { client_id, redirect_uri, state, code_challenge, code_challenge_method, response_type } =
    req.query;

  if (response_type !== "code") {
    return res.status(400).send("Only response_type=code is supported.");
  }
  if (client_id !== OAUTH_CLIENT_ID) {
    return res.status(401).send("Unknown client_id.");
  }
  if (!redirect_uri) {
    return res.status(400).send("Missing redirect_uri.");
  }

  const code = crypto.randomBytes(24).toString("hex");
  authCodes.set(code, {
    redirectUri: redirect_uri,
    codeChallenge: code_challenge || null,
    codeChallengeMethod: code_challenge_method || null,
    expiresAt: Date.now() + 5 * 60 * 1000, // 5 minutes
  });

  const redirectUrl = new URL(redirect_uri);
  redirectUrl.searchParams.set("code", code);
  if (state) redirectUrl.searchParams.set("state", state);
  res.redirect(302, redirectUrl.toString());
});

// Step 2: exchange the code (or a refresh token) for an access token.
app.post("/token", (req, res) => {
  const { grant_type, code, redirect_uri, client_id, client_secret, code_verifier, refresh_token } =
    req.body;

  // Client auth can arrive as Basic auth instead of body params.
  let effectiveClientId = client_id;
  let effectiveClientSecret = client_secret;
  const authHeader = req.headers["authorization"];
  if (!effectiveClientId && authHeader?.startsWith("Basic ")) {
    const decoded = Buffer.from(authHeader.slice(6), "base64").toString("utf8");
    const [id, secret] = decoded.split(":");
    effectiveClientId = id;
    effectiveClientSecret = secret;
  }

  if (effectiveClientId !== OAUTH_CLIENT_ID || effectiveClientSecret !== OAUTH_CLIENT_SECRET) {
    return res.status(401).json({ error: "invalid_client" });
  }

  if (grant_type === "authorization_code") {
    const entry = authCodes.get(code);
    if (!entry || entry.expiresAt < Date.now()) {
      return res.status(400).json({ error: "invalid_grant", error_description: "Code expired or unknown." });
    }
    if (entry.redirectUri !== redirect_uri) {
      return res.status(400).json({ error: "invalid_grant", error_description: "redirect_uri mismatch." });
    }
    if (entry.codeChallenge) {
      if (!code_verifier) {
        return res.status(400).json({ error: "invalid_grant", error_description: "Missing code_verifier." });
      }
      const computed = crypto
        .createHash("sha256")
        .update(code_verifier)
        .digest("base64")
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");
      if (computed !== entry.codeChallenge) {
        return res.status(400).json({ error: "invalid_grant", error_description: "PKCE verification failed." });
      }
    }
    authCodes.delete(code);
    return res.json({
      access_token: issueAccessToken(),
      refresh_token: issueRefreshToken(),
      token_type: "Bearer",
      expires_in: 60 * 60 * 24 * 30,
    });
  }

  if (grant_type === "refresh_token") {
    try {
      const payload = jwt.verify(refresh_token, OAUTH_SIGNING_SECRET);
      if (payload.type !== "refresh") throw new Error("Wrong token type");
    } catch {
      return res.status(400).json({ error: "invalid_grant", error_description: "Invalid refresh token." });
    }
    return res.json({
      access_token: issueAccessToken(),
      refresh_token: issueRefreshToken(),
      token_type: "Bearer",
      expires_in: 60 * 60 * 24 * 30,
    });
  }

  return res.status(400).json({ error: "unsupported_grant_type" });
});

app.post("/mcp", async (req, res) => {
  const authHeader = req.headers["authorization"] || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!token) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  try {
    verifyAccessToken(token);
  } catch {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const server = buildServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });

  res.on("close", () => {
    transport.close();
    server.close();
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("MCP request error:", err);
    if (!res.headersSent) {
      res.status(500).json({ error: "Internal server error" });
    }
  }
});

app.get("/health", (_req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`JobNimbus MCP server listening on port ${PORT}`);
});
