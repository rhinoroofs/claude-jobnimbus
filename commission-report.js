/**
 * Daily SumoQuote commission report
 * -----------------------------------------------------------------------
 * Pulls every SumoQuote estimate that was Approved (signed) on a given day
 * (or date range), downloads each one's SumoQuote PDF, and writes an .xlsx
 * workbook sales reps can use as backup when submitting a commission
 * invoice.
 *
 * Usage (run wherever JOBNIMBUS_API_KEY is set, e.g. next to this repo's
 * deployed server, or locally with a .env file):
 *
 *   node commission-report.js --date 2026-08-03
 *   node commission-report.js --from 2026-08-01 --to 2026-08-03
 *
 * Output:
 *   commission-report-<date>.xlsx      (one row per approved estimate,
 *                                        plus a "By Rep" summary sheet)
 *   commission-pdfs/<date>/<id>.pdf    (the downloaded SumoQuote PDFs)
 *
 * NOTE on JobNimbus quirks discovered while building this:
 *   - The v2/estimates status_name filter is matched against a lowercased
 *     index — pass "approved", not "Approved", or the filter silently
 *     matches nothing.
 *   - The /files/{id} download endpoint below follows JobNimbus's
 *     documented file-download pattern but hasn't been exercised against
 *     this account yet. If it 404s, check Settings -> API in JobNimbus for
 *     the exact attachment-download path and update downloadAttachment().
 * -----------------------------------------------------------------------
 */

import fetch from "node-fetch";
import dotenv from "dotenv";
import ExcelJS from "exceljs";
import fs from "fs";
import path from "path";

dotenv.config();

const JOBNIMBUS_BASE_URL = "https://app.jobnimbus.com/api1";
const JOBNIMBUS_API_KEY = process.env.JOBNIMBUS_API_KEY;

if (!JOBNIMBUS_API_KEY) {
  console.error("Set JOBNIMBUS_API_KEY before running this script.");
  process.exit(1);
}

// Commission rate per sales rep, as a fraction of the approved job total.
// Update this table whenever a rate changes or a rep is added/removed.
const COMMISSION_RATES = {
  "Chuck Canastraro": 0.10,
  "Dave Sanchez": 0.10,
  "Jim Marcil": 0.07,
  "Mike Shelton": 0.07,
  "Phil Graham": 0.15,
  "Shellé Frievalt": 0.07,
  "Luis Quinones": 0,
};

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      args[arg.slice(2)] = argv[i + 1];
      i++;
    }
  }
  return args;
}

/** Unix-second bounds covering the full UTC day for an ISO date string. */
function dayBoundsUnix(dateStr) {
  const start = Math.floor(Date.parse(`${dateStr}T00:00:00Z`) / 1000);
  return { start, end: start + 24 * 60 * 60 - 1 };
}

async function jobNimbusGet(pathname, { query, filter } = {}) {
  let url = `${JOBNIMBUS_BASE_URL}${pathname}`;
  const allQuery = { ...(query || {}) };
  if (filter) allQuery.filter = JSON.stringify(filter);
  const params = new URLSearchParams(
    Object.entries(allQuery).filter(([, v]) => v !== undefined && v !== null)
  );
  if ([...params].length) url += `?${params.toString()}`;

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${JOBNIMBUS_API_KEY}` },
  });
  if (!res.ok) {
    throw new Error(`JobNimbus API error ${res.status} ${res.statusText} on ${pathname}`);
  }
  return res.json();
}

async function fetchApprovedSumoQuoteEstimates(fromDate, toDate) {
  const { start } = dayBoundsUnix(fromDate);
  const { end } = dayBoundsUnix(toDate);
  const filter = {
    must: [
      { term: { status_name: "approved" } },
      { range: { date_status_change: { gte: start, lte: end } } },
    ],
  };
  const data = await jobNimbusGet("/v2/estimates", {
    query: { size: 1000, from: 0 },
    filter,
  });
  return (data.results || []).filter((est) => est.source === "sumoquote");
}

async function downloadAttachment(attachmentId, destDir) {
  const fileId = attachmentId.replace(/^file-/, "");
  const res = await fetch(`${JOBNIMBUS_BASE_URL}/files/${fileId}`, {
    headers: { Authorization: `Bearer ${JOBNIMBUS_API_KEY}` },
  });
  if (!res.ok) {
    console.warn(`  Could not download attachment ${attachmentId}: ${res.status} ${res.statusText}`);
    return null;
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  const destPath = path.join(destDir, `${fileId}.pdf`);
  fs.writeFileSync(destPath, buffer);
  return destPath;
}

async function writeWorkbook(rows, fromDate, toDate) {
  const wb = new ExcelJS.Workbook();

  const sheet = wb.addWorksheet("Commission Report");
  sheet.columns = [
    { header: "Date Approved", key: "dateApproved", width: 14 },
    { header: "Sales Rep", key: "salesRep", width: 20 },
    { header: "Customer / Job", key: "jobName", width: 36 },
    { header: "Job #", key: "jobNumber", width: 10 },
    { header: "Estimate #", key: "estimateNumber", width: 12 },
    { header: "Job Total", key: "total", width: 14 },
    { header: "Commission Rate", key: "rate", width: 14 },
    { header: "Commission Amount", key: "commission", width: 16 },
    { header: "SumoQuote PDF", key: "pdfPath", width: 40 },
    { header: "JobNimbus Job Link", key: "jobUrl", width: 44 },
  ];
  sheet.getRow(1).font = { bold: true };
  rows.forEach((r) => {
    const row = sheet.addRow(r);
    row.getCell("total").numFmt = "$#,##0.00";
    row.getCell("rate").numFmt = "0%";
    row.getCell("commission").numFmt = "$#,##0.00";
  });

  const summarySheet = wb.addWorksheet("By Rep");
  summarySheet.columns = [
    { header: "Sales Rep", key: "salesRep", width: 20 },
    { header: "# Jobs", key: "count", width: 10 },
    { header: "Total Sold", key: "total", width: 16 },
    { header: "Total Commission", key: "commission", width: 18 },
  ];
  summarySheet.getRow(1).font = { bold: true };
  const byRep = {};
  for (const r of rows) {
    byRep[r.salesRep] ??= { salesRep: r.salesRep, count: 0, total: 0, commission: 0 };
    byRep[r.salesRep].count += 1;
    byRep[r.salesRep].total += r.total;
    byRep[r.salesRep].commission += r.commission;
  }
  Object.values(byRep).forEach((r) => {
    const row = summarySheet.addRow(r);
    row.getCell("total").numFmt = "$#,##0.00";
    row.getCell("commission").numFmt = "$#,##0.00";
  });

  const fileName =
    fromDate === toDate
      ? `commission-report-${fromDate}.xlsx`
      : `commission-report-${fromDate}_to_${toDate}.xlsx`;
  await wb.xlsx.writeFile(fileName);
  console.log(`Wrote ${fileName}`);
}

async function main() {
  const args = parseArgs(process.argv);
  const fromDate = args.from || args.date;
  const toDate = args.to || args.date;
  if (!fromDate || !toDate) {
    console.error("Usage: node commission-report.js --date YYYY-MM-DD  (or --from/--to for a range)");
    process.exit(1);
  }

  console.log(`Pulling SumoQuote estimates approved ${fromDate} to ${toDate}...`);
  const estimates = await fetchApprovedSumoQuoteEstimates(fromDate, toDate);
  console.log(`Found ${estimates.length} approved estimate(s).`);

  const pdfDir = path.join("commission-pdfs", fromDate === toDate ? fromDate : `${fromDate}_to_${toDate}`);
  fs.mkdirSync(pdfDir, { recursive: true });

  const rows = [];
  for (const est of estimates) {
    const job = (est.related || []).find((r) => r.type === "job");
    const rate = COMMISSION_RATES[est.sales_rep_name];
    if (rate === undefined) {
      console.warn(`  No commission rate on file for "${est.sales_rep_name}" — defaulting to 0%.`);
    }

    let pdfPath = "(not available)";
    if (est.attachment_id) {
      const downloaded = await downloadAttachment(est.attachment_id, pdfDir);
      if (downloaded) pdfPath = downloaded;
    }

    const total = est.total || 0;
    const appliedRate = rate ?? 0;
    rows.push({
      dateApproved: new Date(est.date_status_change * 1000).toISOString().slice(0, 10),
      salesRep: est.sales_rep_name || "(unassigned)",
      jobName: job?.name || "",
      jobNumber: job?.number || "",
      estimateNumber: est.number,
      total,
      rate: appliedRate,
      commission: total * appliedRate,
      pdfPath,
      jobUrl: job ? `https://app.jobnimbus.com/job/${job.id}` : "",
    });
  }

  await writeWorkbook(rows, fromDate, toDate);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
