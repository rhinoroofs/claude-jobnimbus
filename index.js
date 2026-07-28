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
async function jobNimbusRequest(path, { method = "GET", body, query, filter } = {}) {
  let url = `${JOBNIMBUS_BASE_URL}${path}`;
  const allQuery = { ...(query || {}) };
  if (filter) {
    allQuery.filter = JSON.stringify(filter);
  }
  if (Object.keys(allQuery).length > 0) {
    const params = new URLSearchParams(
      Object.entries(allQuery).filter(([, v]) => v !== undefined && v !== null)
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

/** Build a single Elasticsearch "term" clause (exact match). */
function termClause(field, value) {
  if (value === undefined || value === null || value === "") return null;
  return { term: { [field]: value } };
}

/** Build a single Elasticsearch "range" clause (numeric or date, both as gte/lte). */
function rangeClause(field, gte, lte) {
  const range = {};
  if (gte !== undefined && gte !== null && gte !== "") range.gte = gte;
  if (lte !== undefined && lte !== null && lte !== "") range.lte = lte;
  return Object.keys(range).length > 0 ? { range: { [field]: range } } : null;
}

/** Wrap an array of clauses (some possibly null) into JobNimbus's {must:[...]} filter shape. */
function buildFilter(clauses) {
  const must = clauses.filter(Boolean);
  return must.length > 0 ? { must } : null;
}

/** Convert an ISO date string (or unix seconds number) to unix seconds for JobNimbus date fields. */
function toUnixSeconds(value) {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value === "number") return Math.floor(value);
  const parsed = Date.parse(value);
  if (isNaN(parsed)) throw new Error(`Invalid date value: ${value}`);
  return Math.floor(parsed / 1000);
}

/** Shared pagination/sort/field-limiting params reused across every list tool. */
const commonListFields = {
  size: z
    .number()
    .optional()
    .describe("Number of results to return (default 25 here; JobNimbus's own default/max is 1000)."),
  from: z.number().optional().describe("Zero-based pagination offset. Default 0."),
  sortField: z.string().optional().describe("Field to sort by (default: date_created)."),
  sortDirection: z.enum(["asc", "desc"]).optional().describe("Sort direction (default: desc)."),
  fields: z
    .string()
    .optional()
    .describe(
      "Comma-separated list of field names to include in the response (default: all fields). Use this to keep large result sets small, e.g. 'jnid,name,status_name,date_created'."
    ),
};

function commonListQuery({ size = 25, from = 0, sortField, sortDirection, fields }) {
  return { size, from, sort_field: sortField, sort_direction: sortDirection, fields };
}

/** Build the MCP server and register tools */
function buildServer() {
  const server = new McpServer({
    name: "jobnimbus-mcp",
    version: "1.0.0",
  });

  // ---------- ACCOUNT / REFERENCE ----------
  server.registerTool(
    "jobnimbus_get_account_settings",
    {
      title: "Get JobNimbus Account Settings",
      description:
        "Fetch Rhino's JobNimbus workflow configuration: every workflow (per object type — contact/job/workorder) with its exact list of valid status names, plus file types, task types, activity types, and lead sources. ALWAYS call this first when unsure of the exact spelling of a status_name, record_type_name, or source_name before filtering — status names are easy to get subtly wrong (e.g. singular vs plural, exact punctuation).",
      inputSchema: {},
    },
    async () => {
      const data = await jobNimbusRequest("/account/settings");
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.registerTool(
    "jobnimbus_get_users",
    {
      title: "Get JobNimbus Users",
      description: "List all JobNimbus team members/users (id, name, email, active status).",
      inputSchema: {},
    },
    async () => {
      const data = await jobNimbusRequest("/account/users");
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  // ---------- JOBS ----------
  server.registerTool(
    "jobnimbus_list_jobs",
    {
      title: "List JobNimbus Jobs",
      description:
        "List/search jobs in JobNimbus with exact-match and range filters (status, record type/board, sales rep, lead/closed flags, date ranges, and revenue/profit/margin ranges). Status and record-type names must match JobNimbus's exact spelling — call jobnimbus_get_account_settings first if unsure.",
      inputSchema: {
        ...commonListFields,
        statusName: z.string().optional().describe("Exact status_name, e.g. 'Job to be Scheduled', 'Sold', 'Complete'."),
        recordTypeName: z.string().optional().describe("Exact record_type_name (workflow), e.g. 'Retail', 'Commercial', 'Warranty', 'Insurance'."),
        salesRepName: z.string().optional().describe("Exact sales_rep_name."),
        isLead: z.boolean().optional(),
        isClosed: z.boolean().optional(),
        relatedJnid: z.string().optional().describe("Filter to jobs related to a specific contact/job jnid."),
        dateCreatedFrom: z.string().optional().describe("ISO date, e.g. '2026-07-20'."),
        dateCreatedTo: z.string().optional(),
        dateUpdatedFrom: z.string().optional(),
        dateUpdatedTo: z.string().optional(),
        dateStatusChangeFrom: z.string().optional().describe("Filters by when the job's status last changed — use for 'jobs that changed status last week' type queries."),
        dateStatusChangeTo: z.string().optional(),
        revenueMin: z.number().optional().describe("Minimum last_budget_revenue."),
        revenueMax: z.number().optional(),
        grossProfitMin: z.number().optional().describe("Minimum last_budget_gross_profit."),
        grossProfitMax: z.number().optional(),
        grossMarginMin: z.number().optional().describe("Minimum last_budget_gross_margin (percentage)."),
        grossMarginMax: z.number().optional(),
        lastEstimateMin: z.number().optional().describe("Minimum last_estimate value."),
        lastEstimateMax: z.number().optional(),
        lastInvoiceMin: z.number().optional().describe("Minimum last_invoice value."),
        lastInvoiceMax: z.number().optional(),
      },
    },
    async (params) => {
      const filter = buildFilter([
        termClause("status_name", params.statusName),
        termClause("record_type_name", params.recordTypeName),
        termClause("sales_rep_name", params.salesRepName),
        termClause("is_lead", params.isLead),
        termClause("is_closed", params.isClosed),
        termClause("related.id", params.relatedJnid),
        rangeClause("date_created", toUnixSeconds(params.dateCreatedFrom), toUnixSeconds(params.dateCreatedTo)),
        rangeClause("date_updated", toUnixSeconds(params.dateUpdatedFrom), toUnixSeconds(params.dateUpdatedTo)),
        rangeClause("date_status_change", toUnixSeconds(params.dateStatusChangeFrom), toUnixSeconds(params.dateStatusChangeTo)),
        rangeClause("last_budget_revenue", params.revenueMin, params.revenueMax),
        rangeClause("last_budget_gross_profit", params.grossProfitMin, params.grossProfitMax),
        rangeClause("last_budget_gross_margin", params.grossMarginMin, params.grossMarginMax),
        rangeClause("last_estimate", params.lastEstimateMin, params.lastEstimateMax),
        rangeClause("last_invoice", params.lastInvoiceMin, params.lastInvoiceMax),
      ]);
      const data = await jobNimbusRequest("/jobs", { query: commonListQuery(params), filter });
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
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
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.registerTool(
    "jobnimbus_create_job",
    {
      title: "Create JobNimbus Job",
      description:
        "Create a new job in JobNimbus. 'name', 'record_type_name', and 'status_name' are required by JobNimbus. Pass any additional fields via extraFields (e.g. custom fields specific to Rhino's account).",
      inputSchema: {
        name: z.string().describe("The job name (required)."),
        record_type_name: z.string().describe("Workflow name, e.g. 'Retail', 'Commercial', 'Warranty' (required)."),
        status_name: z.string().describe("Initial status, must exist within that workflow (required)."),
        address_line1: z.string().optional(),
        city: z.string().optional(),
        state_text: z.string().optional(),
        zip: z.string().optional(),
        sales_rep: z.string().optional().describe("Assigned sales rep user id."),
        description: z.string().optional(),
        primary: z.object({ id: z.string() }).optional().describe("The primary related contact's jnid."),
        extraFields: z.record(z.any()).optional().describe("Any additional raw JobNimbus fields to include as-is."),
      },
    },
    async ({ extraFields, ...fields }) => {
      const body = { ...fields, ...(extraFields || {}) };
      const data = await jobNimbusRequest("/jobs", { method: "POST", body });
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.registerTool(
    "jobnimbus_update_job",
    {
      title: "Update JobNimbus Job",
      description: "Update fields on an existing job (e.g. change status, add notes, update address).",
      inputSchema: {
        jnid: z.string().describe("The JobNimbus record ID (jnid) of the job to update."),
        fields: z.record(z.any()).describe("Key/value fields to update, e.g. { status_name: 'Completed' }"),
      },
    },
    async ({ jnid, fields }) => {
      const data = await jobNimbusRequest(`/jobs/${jnid}`, { method: "PUT", body: fields });
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  // ---------- CONTACTS ----------
  server.registerTool(
    "jobnimbus_list_contacts",
    {
      title: "List JobNimbus Contacts",
      description:
        "List/search contacts (customers/leads) in JobNimbus with exact-match and range filters. Status/record-type names must match JobNimbus's exact spelling — call jobnimbus_get_account_settings first if unsure.",
      inputSchema: {
        ...commonListFields,
        statusName: z.string().optional().describe("Exact status_name within the contact workflow, e.g. 'Lead'."),
        recordTypeName: z.string().optional().describe("Exact record_type_name (contact workflow name), e.g. 'Customer'."),
        salesRepName: z.string().optional(),
        isLead: z.boolean().optional(),
        isClosed: z.boolean().optional(),
        dateCreatedFrom: z.string().optional().describe("ISO date."),
        dateCreatedTo: z.string().optional(),
        dateUpdatedFrom: z.string().optional(),
        dateUpdatedTo: z.string().optional(),
      },
    },
    async (params) => {
      const filter = buildFilter([
        termClause("status_name", params.statusName),
        termClause("record_type_name", params.recordTypeName),
        termClause("sales_rep_name", params.salesRepName),
        termClause("is_lead", params.isLead),
        termClause("is_closed", params.isClosed),
        rangeClause("date_created", toUnixSeconds(params.dateCreatedFrom), toUnixSeconds(params.dateCreatedTo)),
        rangeClause("date_updated", toUnixSeconds(params.dateUpdatedFrom), toUnixSeconds(params.dateUpdatedTo)),
      ]);
      const data = await jobNimbusRequest("/contacts", { query: commonListQuery(params), filter });
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.registerTool(
    "jobnimbus_get_contact",
    {
      title: "Get JobNimbus Contact",
      description: "Fetch a single contact by its JobNimbus record JNID.",
      inputSchema: { jnid: z.string() },
    },
    async ({ jnid }) => {
      const data = await jobNimbusRequest(`/contacts/${jnid}`);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.registerTool(
    "jobnimbus_create_contact",
    {
      title: "Create JobNimbus Contact",
      description:
        "Create a new contact/lead record in JobNimbus. Needs first_name/last_name, display_name, or company, plus record_type_name and status_name.",
      inputSchema: {
        first_name: z.string().optional(),
        last_name: z.string().optional(),
        display_name: z.string().optional(),
        company: z.string().optional(),
        record_type_name: z.string().describe("Contact workflow name, e.g. 'Customer' (required)."),
        status_name: z.string().describe("Initial status within that workflow (required)."),
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
      const data = await jobNimbusRequest("/contacts", { method: "POST", body });
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  // ---------- TASKS ----------
  server.registerTool(
    "jobnimbus_list_tasks",
    {
      title: "List JobNimbus Tasks",
      description: "List/search tasks with exact-match and date-range filters.",
      inputSchema: {
        ...commonListFields,
        relatedJnid: z.string().optional().describe("jnid of a job or contact to filter tasks for."),
        recordTypeName: z.string().optional().describe("Task type name, e.g. 'Appointment'."),
        isCompleted: z.boolean().optional(),
        dateStartFrom: z.string().optional().describe("ISO date — filters on the task's scheduled start date."),
        dateStartTo: z.string().optional(),
        dateCreatedFrom: z.string().optional(),
        dateCreatedTo: z.string().optional(),
      },
    },
    async (params) => {
      const filter = buildFilter([
        termClause("related.id", params.relatedJnid),
        termClause("record_type_name", params.recordTypeName),
        termClause("is_completed", params.isCompleted),
        rangeClause("date_start", toUnixSeconds(params.dateStartFrom), toUnixSeconds(params.dateStartTo)),
        rangeClause("date_created", toUnixSeconds(params.dateCreatedFrom), toUnixSeconds(params.dateCreatedTo)),
      ]);
      const data = await jobNimbusRequest("/tasks", { query: commonListQuery(params), filter });
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.registerTool(
    "jobnimbus_create_task",
    {
      title: "Create JobNimbus Task",
      description:
        "Create a task, linked to a job or contact. 'title', 'date_start', 'related', and 'record_type_name' are required by JobNimbus.",
      inputSchema: {
        title: z.string().describe("Task title/summary (required)."),
        relatedJnid: z.string().describe("jnid of the job or contact this task relates to (required)."),
        record_type_name: z.string().describe("Task type name, e.g. 'Appointment', 'Call' (required)."),
        date_start: z.string().describe("ISO date/time the task starts (required)."),
        date_end: z.string().optional(),
        description: z.string().optional(),
        priority: z.number().min(0).max(3).optional().describe("0=none, 1=high, 2=medium, 3=low."),
        extraFields: z.record(z.any()).optional(),
      },
    },
    async ({ extraFields, relatedJnid, date_start, date_end, ...fields }) => {
      const body = {
        ...fields,
        date_start: toUnixSeconds(date_start),
        date_end: date_end ? toUnixSeconds(date_end) : undefined,
        related: [{ id: relatedJnid }],
        ...(extraFields || {}),
      };
      const data = await jobNimbusRequest("/tasks", { method: "POST", body });
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  // ---------- ACTIVITIES (notes + status-change log) ----------
  server.registerTool(
    "jobnimbus_list_activities",
    {
      title: "List JobNimbus Activities",
      description:
        "List activity/note entries — this includes JobNimbus's status-change history (each status change on a job/contact logs an activity with is_status_change=true) as well as manually-added notes. Use relatedJnid to see all activity for one job/contact; use isStatusChange=true to see only status transitions.",
      inputSchema: {
        ...commonListFields,
        relatedJnid: z.string().optional().describe("jnid of a job or contact to see all activity for."),
        isStatusChange: z.boolean().optional().describe("Filter to only status-change events (true) or only manual notes (false)."),
        dateCreatedFrom: z.string().optional().describe("ISO date."),
        dateCreatedTo: z.string().optional(),
      },
    },
    async (params) => {
      const filter = buildFilter([
        termClause("related.id", params.relatedJnid),
        termClause("is_status_change", params.isStatusChange),
        rangeClause("date_created", toUnixSeconds(params.dateCreatedFrom), toUnixSeconds(params.dateCreatedTo)),
      ]);
      const data = await jobNimbusRequest("/activities", { query: commonListQuery(params), filter });
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.registerTool(
    "jobnimbus_create_activity",
    {
      title: "Create JobNimbus Activity (Note)",
      description: "Add a note/activity entry to a job or contact.",
      inputSchema: {
        note: z.string().describe("The note text."),
        primaryJnid: z.string().describe("jnid of the job or contact this note is on."),
        record_type_name: z.string().optional().default("Note"),
      },
    },
    async ({ note, primaryJnid, record_type_name = "Note" }) => {
      const data = await jobNimbusRequest("/activities", {
        method: "POST",
        body: { note, record_type_name, primary: { id: primaryJnid } },
      });
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  // ---------- ESTIMATES (v2) ----------
  server.registerTool(
    "jobnimbus_list_estimates",
    {
      title: "List JobNimbus Estimates",
      description: "List/search estimates with exact-match and range filters.",
      inputSchema: {
        ...commonListFields,
        relatedJnid: z.string().optional().describe("jnid of a job/contact to filter estimates for."),
        statusName: z.string().optional().describe("Exact estimate status name, e.g. 'Approved', 'Closed'."),
        salesRepName: z.string().optional(),
        dateEstimateFrom: z.string().optional().describe("ISO date — the estimate's own date."),
        dateEstimateTo: z.string().optional(),
        dateStatusChangeFrom: z.string().optional().describe("Use for 'approved last week' style queries — filters by when the estimate's status last changed."),
        dateStatusChangeTo: z.string().optional(),
        totalMin: z.number().optional(),
        totalMax: z.number().optional(),
      },
    },
    async (params) => {
      const filter = buildFilter([
        termClause("related.id", params.relatedJnid),
        termClause("status_name", params.statusName),
        termClause("sales_rep_name", params.salesRepName),
        rangeClause("date_estimate", toUnixSeconds(params.dateEstimateFrom), toUnixSeconds(params.dateEstimateTo)),
        rangeClause("date_status_change", toUnixSeconds(params.dateStatusChangeFrom), toUnixSeconds(params.dateStatusChangeTo)),
        rangeClause("total", params.totalMin, params.totalMax),
      ]);
      const data = await jobNimbusRequest("/v2/estimates", { query: commonListQuery(params), filter });
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.registerTool(
    "jobnimbus_get_estimate",
    {
      title: "Get JobNimbus Estimate",
      description: "Fetch a single estimate by jnid.",
      inputSchema: { jnid: z.string() },
    },
    async ({ jnid }) => {
      const data = await jobNimbusRequest(`/v2/estimates/${jnid}`);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  // ---------- INVOICES (v2) ----------
  server.registerTool(
    "jobnimbus_list_invoices",
    {
      title: "List JobNimbus Invoices",
      description: "List/search invoices with exact-match and range filters — useful for AR / collections views.",
      inputSchema: {
        ...commonListFields,
        relatedJnid: z.string().optional().describe("jnid of a job/contact to filter invoices for."),
        statusName: z.string().optional(),
        salesRepName: z.string().optional(),
        dateInvoiceFrom: z.string().optional().describe("ISO date."),
        dateInvoiceTo: z.string().optional(),
        dateDueFrom: z.string().optional(),
        dateDueTo: z.string().optional(),
        totalMin: z.number().optional(),
        totalMax: z.number().optional(),
        dueMin: z.number().optional().describe("Minimum amount still due."),
        dueMax: z.number().optional(),
      },
    },
    async (params) => {
      const filter = buildFilter([
        termClause("related.id", params.relatedJnid),
        termClause("status_name", params.statusName),
        termClause("sales_rep_name", params.salesRepName),
        rangeClause("date_invoice", toUnixSeconds(params.dateInvoiceFrom), toUnixSeconds(params.dateInvoiceTo)),
        rangeClause("date_due", toUnixSeconds(params.dateDueFrom), toUnixSeconds(params.dateDueTo)),
        rangeClause("total", params.totalMin, params.totalMax),
        rangeClause("due", params.dueMin, params.dueMax),
      ]);
      const data = await jobNimbusRequest("/v2/invoices", { query: commonListQuery(params), filter });
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.registerTool(
    "jobnimbus_get_invoice",
    {
      title: "Get JobNimbus Invoice",
      description: "Fetch a single invoice by jnid.",
      inputSchema: { jnid: z.string() },
    },
    async ({ jnid }) => {
      const data = await jobNimbusRequest(`/v2/invoices/${jnid}`);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  // ---------- PAYMENTS ----------
  server.registerTool(
    "jobnimbus_list_payments",
    {
      title: "List JobNimbus Payments",
      description: "List payments recorded against invoices.",
      inputSchema: {
        ...commonListFields,
        relatedJnid: z.string().optional().describe("jnid of an invoice/job/contact to filter payments for."),
        datePaymentFrom: z.string().optional().describe("ISO date."),
        datePaymentTo: z.string().optional(),
      },
    },
    async (params) => {
      const filter = buildFilter([
        termClause("related.id", params.relatedJnid),
        rangeClause("date_payment", toUnixSeconds(params.datePaymentFrom), toUnixSeconds(params.datePaymentTo)),
      ]);
      const data = await jobNimbusRequest("/payments", { query: commonListQuery(params), filter });
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  // ---------- BUDGETS (profit tracker) ----------
  server.registerTool(
    "jobnimbus_list_budgets",
    {
      title: "List JobNimbus Budgets (Profit Tracker)",
      description:
        "List job budgets — this is Rhino's 'profit tracker' data: revenue, total cost, gross profit, gross margin, net profit, net margin, and commissions per job. Use date/rep/status filters to slice by time period, sales rep, or budget status.",
      inputSchema: {
        ...commonListFields,
        statusName: z.string().optional(),
        salesRepName: z.string().optional(),
        relatedJnid: z.string().optional().describe("jnid of the related job/contact."),
        dateBudgetFrom: z.string().optional().describe("ISO date."),
        dateBudgetTo: z.string().optional(),
        dateStatusChangeFrom: z.string().optional(),
        dateStatusChangeTo: z.string().optional(),
        revenueMin: z.number().optional(),
        revenueMax: z.number().optional(),
        grossProfitMin: z.number().optional(),
        grossProfitMax: z.number().optional(),
        grossMarginMin: z.number().optional(),
        grossMarginMax: z.number().optional(),
        netProfitMin: z.number().optional(),
        netProfitMax: z.number().optional(),
        netMarginMin: z.number().optional(),
        netMarginMax: z.number().optional(),
      },
    },
    async (params) => {
      const filter = buildFilter([
        termClause("status_name", params.statusName),
        termClause("sales_rep_name", params.salesRepName),
        termClause("related.id", params.relatedJnid),
        rangeClause("date_budget", toUnixSeconds(params.dateBudgetFrom), toUnixSeconds(params.dateBudgetTo)),
        rangeClause("date_status_change", toUnixSeconds(params.dateStatusChangeFrom), toUnixSeconds(params.dateStatusChangeTo)),
        rangeClause("revenue", params.revenueMin, params.revenueMax),
        rangeClause("gross_profit", params.grossProfitMin, params.grossProfitMax),
        rangeClause("gross_margin", params.grossMarginMin, params.grossMarginMax),
        rangeClause("net_profit", params.netProfitMin, params.netProfitMax),
        rangeClause("net_margin", params.netMarginMin, params.netMarginMax),
      ]);
      const data = await jobNimbusRequest("/budgets", { query: commonListQuery(params), filter });
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  // ---------- MATERIAL ORDERS ----------
  server.registerTool(
    "jobnimbus_list_material_orders",
    {
      title: "List JobNimbus Material Orders",
      description:
        "List/search material orders (MOs) — exact-match filters include the MO number itself, so you can look up a specific Material Order by its # (e.g. '1001') the same way it's searchable in JobNimbus's own UI. Also filterable by related job/contact, status, sales rep, and date ranges.",
      inputSchema: {
        ...commonListFields,
        number: z.string().optional().describe("Exact material order number (MO#), e.g. '1001'."),
        relatedJnid: z.string().optional().describe("jnid of the job/contact this MO is related to."),
        statusName: z.string().optional().describe("Exact status name, e.g. 'Draft', 'Ordered', 'Received'."),
        salesRepName: z.string().optional(),
        dateMaterialOrderFrom: z.string().optional().describe("ISO date — the MO's own date."),
        dateMaterialOrderTo: z.string().optional(),
        dateStatusChangeFrom: z.string().optional(),
        dateStatusChangeTo: z.string().optional(),
      },
    },
    async (params) => {
      const filter = buildFilter([
        termClause("number", params.number),
        termClause("related.id", params.relatedJnid),
        termClause("status_name", params.statusName),
        termClause("sales_rep_name", params.salesRepName),
        rangeClause("date_materialorder", toUnixSeconds(params.dateMaterialOrderFrom), toUnixSeconds(params.dateMaterialOrderTo)),
        rangeClause("date_status_change", toUnixSeconds(params.dateStatusChangeFrom), toUnixSeconds(params.dateStatusChangeTo)),
      ]);
      const data = await jobNimbusRequest("/v2/materialorders", { query: commonListQuery(params), filter });
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.registerTool(
    "jobnimbus_get_material_order",
    {
      title: "Get JobNimbus Material Order",
      description: "Fetch a single material order by its jnid (use jobnimbus_list_material_orders with a 'number' filter first if you only have the MO#).",
      inputSchema: { jnid: z.string() },
    },
    async ({ jnid }) => {
      const data = await jobNimbusRequest(`/v2/materialorders/${jnid}`);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.registerTool(
    "jobnimbus_create_material_order",
    {
      title: "Create JobNimbus Material Order",
      description: "Create a new material order, related to a job/contact.",
      inputSchema: {
        relatedJnid: z.string().describe("jnid of the job/contact this MO is for."),
        status_name: z.string().optional().default("Draft"),
        internal_note: z.string().optional(),
        customer_note: z.string().optional(),
        items: z
          .array(
            z.object({
              name: z.string(),
              description: z.string().optional(),
              quantity: z.number(),
              cost: z.number().optional(),
              price: z.number().optional(),
              uom: z.string().optional(),
              sku: z.string().optional(),
              category: z.string().optional(),
            })
          )
          .describe("Line items for the material order."),
        extraFields: z.record(z.any()).optional(),
      },
    },
    async ({ relatedJnid, items, extraFields, ...fields }) => {
      const body = {
        ...fields,
        related: [{ id: relatedJnid }],
        items,
        ...(extraFields || {}),
      };
      const data = await jobNimbusRequest("/v2/materialorders", { method: "POST", body });
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.registerTool(
    "jobnimbus_update_material_order",
    {
      title: "Update JobNimbus Material Order",
      description: "Update fields on an existing material order (e.g. change status, update items).",
      inputSchema: {
        jnid: z.string().describe("The jnid of the material order to update."),
        fields: z.record(z.any()).describe("Key/value fields to update, e.g. { status_name: 'Ordered' }"),
      },
    },
    async ({ jnid, fields }) => {
      const data = await jobNimbusRequest(`/v2/materialorders/${jnid}`, { method: "PUT", body: fields });
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
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
