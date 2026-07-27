# JobNimbus MCP Server

This is a small server that lets Claude read and write data in JobNimbus —
jobs, contacts, tasks, and estimates — by translating between Claude's MCP
protocol and JobNimbus's REST API.

Once this is deployed and connected in Claude.ai, Claude will have live tools
like "list jobs," "create contact," "update job status," etc.

---

## 1. Get your JobNimbus API key

In JobNimbus: **Settings (gear icon) → API** → copy your API key.

---

## 2. Deploy the server

You need this running somewhere with a public HTTPS URL. Two easy free/cheap
options — pick one:

### Option A: Railway (simplest)
1. Create a free account at https://railway.app
2. New Project → "Deploy from GitHub repo" (push this folder to a new GitHub
   repo first), or use Railway's CLI to deploy this folder directly:
   ```
   npm install -g @railway/cli
   railway login
   railway init
   railway up
   ```
3. In Railway's dashboard, go to your service → **Variables** and add:
   - `JOBNIMBUS_API_KEY` = your key from step 1
   - `MCP_SHARED_SECRET` = (optional) a random string, e.g. output of `openssl rand -hex 24`
4. Railway will give you a public URL like `https://your-app.up.railway.app`.
   Your MCP endpoint is that URL + `/mcp`, e.g.
   `https://your-app.up.railway.app/mcp`

### Option B: Render
1. Create a free account at https://render.com
2. New → Web Service → connect the GitHub repo containing this folder
   (or "Public Git repository" if you push it there).
3. Build command: `npm install`  |  Start command: `npm start`
4. Add environment variables `JOBNIMBUS_API_KEY` (and optionally
   `MCP_SHARED_SECRET`) under the service's **Environment** tab.
5. Render gives you a URL like `https://your-app.onrender.com`.
   Your MCP endpoint is `https://your-app.onrender.com/mcp`

> Note: this repo isn't pushed to GitHub yet — you (or whoever's deploying,
> e.g. a developer helping with JobNimbus admin) will need to create a repo,
> push these files, then point Railway/Render at it. If you want, I can also
> walk through doing this without GitHub using a host's CLI-only deploy.

---

## 3. Connect it in Claude.ai

1. In Claude.ai: **Settings → Connectors → Add custom connector**
2. Paste in your `/mcp` URL from step 2
3. If you set `MCP_SHARED_SECRET`, add it as a custom header:
   `x-mcp-secret: <your secret value>`
4. Save. Claude will now show JobNimbus tools (list jobs, create contact,
   update job, etc.) whenever relevant, or you can name them directly.

---

## 4. Verify the endpoints match your account

JobNimbus's exact field names can vary a bit by account (custom fields,
job status names, record types). This server ships with the standard
JobNimbus API1 structure, but **before relying on it**:

- Test `jobnimbus_list_jobs` first (harmless, read-only) to confirm auth works
  and field names look right.
- If a create/update call 404s or rejects fields, check your JobNimbus
  account's API docs (Settings → API → documentation link) for the exact
  field names your account uses, and adjust the `inputSchema` /
  `extraFields` in `index.js` accordingly.

## What's included

| Tool | What it does |
|---|---|
| `jobnimbus_list_jobs` | Search/list jobs |
| `jobnimbus_get_job` | Get one job by ID |
| `jobnimbus_create_job` | Create a new job |
| `jobnimbus_update_job` | Update an existing job (status, notes, etc.) |
| `jobnimbus_list_contacts` | Search/list contacts |
| `jobnimbus_create_contact` | Create a new contact/lead |
| `jobnimbus_list_tasks` | List tasks, optionally by related job/contact |
| `jobnimbus_create_task` | Create a task |
| `jobnimbus_list_estimates` | List estimates, optionally by related job |

Want more (e.g. invoices, documents, work orders)? These follow the same
pattern — say the word and I'll add tools for them.

## Security notes

- Your JobNimbus API key lives only in this server's environment variables —
  never in Claude, never in a browser.
- Setting `MCP_SHARED_SECRET` is optional but recommended, since anyone who
  gets your `/mcp` URL could otherwise call it.
- This server has full read/write access matching whatever your API key can
  do. If you want a read-only version for safer experimentation, say so and
  I'll strip out the create/update tools.
