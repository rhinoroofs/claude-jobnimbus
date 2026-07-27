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
import {
  McpServer,
} from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

dotenv.config();

const JOBNIMBUS_BASE_URL = "https://app.jobnimbus.com/api1";
const JOBNIMBUS_API_KEY = process.env.JOBNIMBUS_API_KEY;
// Optional simple shared-secret so random people on the internet can't hit
// your server. Set MCP_SHARED_SECRET in your env and pass the same value
// as a header when adding the connector, if your host supports it.
const MCP_SHARED_SECRET = process.env.MCP_SHARED_SECRET || null;

if (!JOBNIMBUS_API_KEY) {
  console.error(
    "FATAL: JOBNIMBUS_API_KEY is not set. Add it to your environment before starting the server."
  );
  process.exit(1);
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
// Express app hosting the MCP server over Streamable HTTP transport.
// This is what you deploy; the resulting public URL + "/mcp" path is what
// gets entered as the custom connector URL in Claude.ai.
// -----------------------------------------------------------------------
const app = express();
app.use(express.json());

app.post("/mcp", async (req, res) => {
  if (MCP_SHARED_SECRET) {
    const provided = req.headers["x-mcp-secret"];
    if (provided !== MCP_SHARED_SECRET) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
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
