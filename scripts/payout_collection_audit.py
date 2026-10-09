#!/usr/bin/env python3
"""
Rhino Roofs - Payout vs. Collection Audit
==========================================

Question this answers:
  From June 1 to now, which jobs had a sub paid for INSTALL before the customer's
  last payment was collected, or paid for DEMO before the customer's 2nd payment
  was collected?

Source of truth for payouts: the two payroll workbooks
  - Copy_of_Crew_Payroll_Sheet.xlsx   (tab "Payroll")  -> June 1 - July 20, has Job #
  - Rhino_Roofs___Payroll.xlsx        (tab "Payroll")  -> July 24 - now, mostly address only

For every Demo / Install payout it pulls from JobNimbus:
  - the job (contract total, current status, current collected / owed)
  - status-change history  -> status on the payout date
  - payment history        -> collected / owed on the payout date

Payout date:
  - Default = the payroll sheet date.
  - Optional: pass --nickel nickel_bills.csv (export of PAID Nickel bills with
    columns: reference, vendorName, description, paidDate). When a Nickel bill
    for the same job # is found within NICKEL_MATCH_WINDOW_DAYS of the payroll
    date, its paid date is used instead.

Flag rules (edit in CONFIG below):
  - INSTALL flagged if collected at payout < contract (anything still owed).
  - DEMO flagged if collected at payout < 2/3 of contract AND the status at
    payout was not one of SECOND_PAYMENT_STATUSES.
  - "Demo + Install" lines are checked with the INSTALL rule.

Output: payout_collection_audit.xlsx with tabs
  Summary | Flagged Payouts | All Payouts | Unmatched Rows | Status Changes Log

Usage:
  pip install pandas openpyxl requests
  export JOBNIMBUS_API_KEY="your key"
  python payout_collection_audit.py --crew Copy_of_Crew_Payroll_Sheet.xlsx \
        --rhino Rhino_Roofs___Payroll.xlsx [--nickel nickel_bills.csv] \
        [--start 2026-06-01] [--out payout_collection_audit.xlsx]

  python payout_collection_audit.py --probe 11518     # test the API on one job
  python payout_collection_audit.py ... --dry-run     # parse payroll only, no API

API responses are cached in ./jn_cache so re-runs are fast and cheap.
"""

import argparse
import difflib
import hashlib
import json
import os
import re
import sys
import time
from datetime import datetime, timedelta, timezone

import pandas as pd
import requests
from openpyxl import Workbook
from openpyxl.styles import Alignment, Font, PatternFill
from openpyxl.utils import get_column_letter

# =============================================================================
# CONFIG
# =============================================================================
JN_BASE_URL = os.environ.get("JOBNIMBUS_BASE_URL", "https://app.jobnimbus.com/api1")
JN_API_KEY = os.environ.get("JOBNIMBUS_API_KEY", "")

# Endpoint paths (relative to JN_BASE_URL). Adjust here if your account differs.
EP_JOBS = "jobs"
EP_ACTIVITIES = "activities"
EP_PAYMENTS = "payments"

DEFAULT_START = "2026-06-01"
CACHE_DIR = "jn_cache"
REQUEST_PAUSE_SEC = 0.25          # be gentle with the API
PAGE_SIZE = 1000

DEMO_SECOND_PAYMENT_RATIO = 2 / 3  # demo OK if >= this share of contract collected
OWED_TOLERANCE = 1.00              # ignore balances under $1 (rounding)
NICKEL_MATCH_WINDOW_DAYS = 14

# Statuses that mean the 2nd payment is in (case-insensitive substring match).
SECOND_PAYMENT_STATUSES = ["2nd payment done", "final invoice paid", "paid & closed"]

# Work types to skip even if they contain "install"/"demo"
EXCLUDE_WORK_TYPES = ["fascia install"]

# Address-matching threshold for the Rhino sheet (0-1, higher = stricter)
ADDRESS_MATCH_CUTOFF = 0.80

FONT = "Arial"


# =============================================================================
# JobNimbus API client (with disk cache)
# =============================================================================
class JobNimbus:
    def __init__(self, base_url, api_key, cache_dir=CACHE_DIR, use_cache=True):
        if not api_key:
            sys.exit("ERROR: set JOBNIMBUS_API_KEY in your environment.")
        self.base = base_url.rstrip("/")
        self.s = requests.Session()
        self.s.headers.update({
            "Authorization": f"bearer {api_key}",
            "Content-Type": "application/json",
        })
        self.cache_dir = cache_dir
        self.use_cache = use_cache
        os.makedirs(cache_dir, exist_ok=True)

    def _cache_path(self, key):
        return os.path.join(self.cache_dir, hashlib.md5(key.encode()).hexdigest() + ".json")

    def _get(self, endpoint, params):
        key = endpoint + json.dumps(params, sort_keys=True)
        path = self._cache_path(key)
        if self.use_cache and os.path.exists(path):
            with open(path) as f:
                return json.load(f)
        url = f"{self.base}/{endpoint}"
        for attempt in range(5):
            r = self.s.get(url, params=params, timeout=60)
            if r.status_code == 429:
                time.sleep(2 + attempt * 2)
                continue
            r.raise_for_status()
            data = r.json()
            break
        else:
            raise RuntimeError(f"Rate-limited repeatedly on {url}")
        time.sleep(REQUEST_PAUSE_SEC)
        with open(path, "w") as f:
            json.dump(data, f)
        return data

    def list_all(self, endpoint, must=None, fields=None, sort_field="date_created"):
        out, start = [], 0
        while True:
            params = {"size": PAGE_SIZE, "from": start,
                      "sort_field": sort_field, "sort_direction": "asc"}
            if must:
                params["filter"] = json.dumps({"must": must})
            if fields:
                params["fields"] = fields
            data = self._get(endpoint, params)
            rows = data.get("results", data if isinstance(data, list) else [])
            out.extend(rows)
            total = data.get("count", len(out)) if isinstance(data, dict) else len(out)
            start += PAGE_SIZE
            if not rows or start >= total:
                break
        return out

    # --- convenience ---------------------------------------------------------
    def job_by_number(self, number):
        rows = self.list_all(EP_JOBS, must=[{"term": {"number": str(number)}}])
        return rows[0] if rows else None

    def status_changes(self, jnid):
        return self.list_all(EP_ACTIVITIES, must=[
            {"term": {"related.id": jnid}},
            {"term": {"is_status_change": True}},
        ])

    def payments(self, jnid):
        return self.list_all(EP_PAYMENTS, must=[{"term": {"related.id": jnid}}],
                             sort_field="date_payment")

    def all_jobs_light(self):
        """All jobs with address fields, for address matching."""
        return self.list_all(
            EP_JOBS,
            fields="jnid,number,name,address_line1,city,zip,status_name,date_created",
        )


# =============================================================================
# Payroll parsing
# =============================================================================
def classify(work_type):
    t = str(work_type or "").strip().lower()
    if not t or t == "nan":
        return None
    if any(x in t for x in EXCLUDE_WORK_TYPES):
        return None
    has_demo, has_inst = "demo" in t, "install" in t
    if has_demo and has_inst:
        return "Demo + Install"
    if has_inst:
        return "Install"
    if has_demo:
        return "Demo"
    return None


def extract_job_number(v):
    if v is None or (isinstance(v, float) and pd.isna(v)):
        return None
    m = re.search(r"(\d{3,6})", str(v))
    return m.group(1) if m else None


def load_payroll(crew_path, rhino_path, start):
    rows = []

    if crew_path:
        a = pd.read_excel(crew_path, sheet_name="Payroll")
        a["Date"] = pd.to_datetime(a["Date"], errors="coerce")
        for _, r in a.iterrows():
            if pd.isna(r["Date"]):
                continue
            kind = classify(r.get("Demo/Install/Repair"))
            if not kind:
                continue
            amt = r.get("AMT for the job")
            if pd.isna(amt):
                amt = r.get("Subtotal")
            rows.append({
                "source": "Crew Payroll Sheet",
                "payroll_date": r["Date"],
                "job_number": extract_job_number(r.get("Job #")),
                "address": str(r.get("Address") or "").strip(),
                "sub": str(r.get("Subcontractor") or "").strip(),
                "work_type": str(r.get("Demo/Install/Repair")).strip(),
                "kind": kind,
                "amount": float(amt) if pd.notna(amt) else 0.0,
            })

    if rhino_path:
        b = pd.read_excel(rhino_path, sheet_name="Payroll")
        b["DATE"] = pd.to_datetime(b["DATE"], errors="coerce")
        for _, r in b.iterrows():
            if pd.isna(r["DATE"]):
                continue
            kind = classify(r.get("WORK TYPE"))
            if not kind:
                continue
            amt = r.get("TOTAL $")
            if pd.isna(amt):
                amt = r.get("AMT JOB $")
            rows.append({
                "source": "Rhino Roofs Payroll",
                "payroll_date": r["DATE"],
                "job_number": extract_job_number(r.get("JOB #")),
                "address": str(r.get("ADDRESS") or "").strip(),
                "sub": str(r.get("SUBCONTRACTOR") or "").strip(),
                "work_type": str(r.get("WORK TYPE")).strip(),
                "kind": kind,
                "amount": float(amt) if pd.notna(amt) else 0.0,
            })

    df = pd.DataFrame(rows)
    df = df[df["payroll_date"] >= pd.Timestamp(start)].reset_index(drop=True)
    return df


# =============================================================================
# Address matching (for rows with no job #)
# =============================================================================
SUFFIXES = {
    "street": "st", "st": "st", "avenue": "ave", "ave": "ave", "drive": "dr", "dr": "dr",
    "road": "rd", "rd": "rd", "court": "ct", "ct": "ct", "circle": "cir", "cir": "cir",
    "lane": "ln", "ln": "ln", "boulevard": "blvd", "blvd": "blvd", "terrace": "ter",
    "ter": "ter", "place": "pl", "pl": "pl", "way": "way", "trace": "trce", "trce": "trce",
    "parkway": "pkwy", "pkwy": "pkwy", "highway": "hwy", "hwy": "hwy",
}
DIRS = {"north": "n", "south": "s", "east": "e", "west": "w", "northeast": "ne",
        "northwest": "nw", "southeast": "se", "southwest": "sw"}


def norm_addr(s):
    s = str(s or "").lower()
    s = s.split(",")[0]                       # street part only
    s = re.sub(r"^(bldg|bld|building)\s*\d+\s*-\s*", "", s)
    s = re.sub(r"[^a-z0-9 ]", " ", s)
    toks = []
    for t in s.split():
        t = DIRS.get(t, t)
        t = SUFFIXES.get(t, t)
        toks.append(t)
    return " ".join(toks).strip()


def house_number(s):
    m = re.match(r"\s*\*?(\d+)", str(s or ""))
    return m.group(1) if m else None


class AddressIndex:
    def __init__(self, jobs):
        self.by_num = {}
        for j in jobs:
            a1 = j.get("address_line1") or ""
            hn = house_number(a1)
            if not hn:
                continue
            self.by_num.setdefault(hn, []).append((norm_addr(a1), j))

    def match(self, address):
        hn = house_number(address)
        if not hn or hn not in self.by_num:
            return None, 0.0, "no job with that house number"
        target = norm_addr(address)
        best, best_score = None, 0.0
        for cand_norm, job in self.by_num[hn]:
            score = difflib.SequenceMatcher(None, target, cand_norm).ratio()
            if score > best_score:
                best, best_score = job, score
        if best is None or best_score < ADDRESS_MATCH_CUTOFF:
            return None, best_score, "address similarity below cutoff"
        # ambiguity check: two different jobs at nearly the same score
        close = [j for n, j in self.by_num[hn]
                 if difflib.SequenceMatcher(None, target, n).ratio() >= best_score - 0.02
                 and j.get("number") != best.get("number")]
        if close:
            nums = ", ".join(sorted({str(best.get("number"))} | {str(c.get("number")) for c in close}))
            return best, best_score, f"ambiguous ({nums}) - picked most recent"
        return best, best_score, "ok"


# =============================================================================
# Nickel paid-date matching (optional)
# =============================================================================
def load_nickel(path):
    if not path:
        return None
    n = pd.read_csv(path)
    cols = {c.lower(): c for c in n.columns}
    ref = cols.get("reference")
    paid = cols.get("paiddate") or cols.get("paid_date") or cols.get("paid date")
    if not ref or not paid:
        sys.exit("Nickel CSV needs 'reference' and 'paidDate' columns.")
    n["_job"] = n[ref].astype(str).str.extract(r"^\s*(\d{3,6})")[0]
    n["_paid"] = pd.to_datetime(n[paid], errors="coerce")
    desc = cols.get("description")
    n["_desc"] = n[desc].astype(str).str.lower() if desc else ""
    return n.dropna(subset=["_job", "_paid"])


def nickel_paid_date(nickel, job_number, payroll_date, kind):
    if nickel is None or not job_number:
        return None
    c = nickel[nickel["_job"] == str(job_number)].copy()
    if c.empty:
        return None
    word = "demo" if kind == "Demo" else "install"
    pref = c[c["_desc"].str.contains(word, na=False)]
    if not pref.empty:
        c = pref
    c["_gap"] = (c["_paid"] - payroll_date).abs()
    c = c[c["_gap"] <= pd.Timedelta(days=NICKEL_MATCH_WINDOW_DAYS)]
    if c.empty:
        return None
    return c.sort_values("_gap").iloc[0]["_paid"]


# =============================================================================
# Status / payment helpers
# =============================================================================
STATUS_TO_RE = re.compile(r"\bto\s+[\"']?([^\"'\n]+?)[\"']?\s*$", re.IGNORECASE)


def ts(v):
    """JobNimbus epoch seconds -> UTC datetime."""
    try:
        return datetime.fromtimestamp(int(v), tz=timezone.utc)
    except (TypeError, ValueError):
        return None


def new_status_from_activity(a):
    for k in ("status_name_new", "new_status_name", "status_name"):
        if a.get(k):
            return str(a[k])
    note = str(a.get("note") or "")
    m = STATUS_TO_RE.search(note)
    if m:
        return m.group(1).strip()
    return note.strip() or "Unknown"


def status_on(changes, when):
    """Latest status change on/before `when` (end of that day)."""
    cutoff = when.replace(tzinfo=timezone.utc) + timedelta(days=1)
    best_t, best_s = None, None
    for a in changes:
        t = ts(a.get("date_created"))
        if t and t < cutoff and (best_t is None or t > best_t):
            best_t, best_s = t, new_status_from_activity(a)
    return best_s, best_t


def paid_amount(p):
    total = float(p.get("total") or 0)
    refunded = float(p.get("refunded_amount") or 0)
    return total - refunded


def collected_by(payments, when):
    cutoff = when.replace(tzinfo=timezone.utc) + timedelta(days=1)
    s = 0.0
    for p in payments:
        if not p.get("is_active", True):
            continue
        t = ts(p.get("date_payment")) or ts(p.get("date_created"))
        if t and t < cutoff:
            s += paid_amount(p)
    return round(s, 2)


def collected_total(payments):
    return round(sum(paid_amount(p) for p in payments if p.get("is_active", True)), 2)


def contract_value(job):
    est = float(job.get("approved_estimate_total") or 0)
    inv = float(job.get("approved_invoice_total") or 0)
    return round(max(est, inv), 2)


def second_payment_status(status):
    s = str(status or "").lower()
    return any(x in s for x in SECOND_PAYMENT_STATUSES)


# =============================================================================
# Main audit
# =============================================================================
def run(args):
    payroll = load_payroll(args.crew, args.rhino, args.start)
    print(f"Payroll demo/install lines since {args.start}: {len(payroll)}")
    print(f"  with job #: {payroll['job_number'].notna().sum()}  "
          f"address only: {payroll['job_number'].isna().sum()}")

    if args.dry_run:
        payroll.to_csv("payroll_parsed.csv", index=False)
        print("Dry run: wrote payroll_parsed.csv")
        return

    jn = JobNimbus(JN_BASE_URL, JN_API_KEY, use_cache=not args.no_cache)
    nickel = load_nickel(args.nickel)

    # --- resolve address-only rows ------------------------------------------
    match_note = [""] * len(payroll)
    if payroll["job_number"].isna().any():
        print("Loading all JobNimbus jobs for address matching ...")
        idx = AddressIndex(jn.all_jobs_light())
        for i, r in payroll.iterrows():
            if pd.notna(r["job_number"]):
                match_note[i] = "job # on payroll"
                continue
            job, score, note = idx.match(r["address"])
            if job:
                payroll.at[i, "job_number"] = str(job.get("number"))
                match_note[i] = f"address match {score:.2f} ({note})"
            else:
                match_note[i] = f"UNMATCHED: {note}"
    else:
        match_note = ["job # on payroll"] * len(payroll)
    payroll["match_note"] = match_note

    # --- pull job data once per job -----------------------------------------
    job_cache, status_log = {}, []
    for num in sorted(payroll["job_number"].dropna().unique(), key=lambda x: int(x)):
        job = jn.job_by_number(num)
        if not job:
            job_cache[num] = None
            continue
        jnid = job["jnid"]
        changes = jn.status_changes(jnid)
        pays = jn.payments(jnid)
        job_cache[num] = {"job": job, "changes": changes, "payments": pays}
        for a in changes:
            status_log.append({
                "Job #": num,
                "Changed At (UTC)": ts(a.get("date_created")),
                "New Status": new_status_from_activity(a),
                "Raw Note": a.get("note"),
            })
        print(f"  {num}: {len(changes)} status changes, {len(pays)} payments")

    # --- evaluate each payout -----------------------------------------------
    out = []
    for _, r in payroll.iterrows():
        num = r["job_number"] if pd.notna(r["job_number"]) else None
        rec = {
            "Job #": num,
            "Address (payroll)": r["address"],
            "Sub": r["sub"],
            "Work Type": r["work_type"],
            "Kind": r["kind"],
            "Payroll Date": r["payroll_date"].date(),
            "Payout Amount": round(r["amount"], 2),
            "Source": r["source"],
            "Match Note": r["match_note"],
        }
        data = job_cache.get(num) if num else None
        if not data:
            rec["Problem"] = "job not found" if num else "no job # / address unmatched"
            out.append(rec)
            continue

        job = data["job"]
        npd = nickel_paid_date(nickel, num, r["payroll_date"], r["kind"])
        payout_dt = (npd if npd is not None else r["payroll_date"]).to_pydatetime()
        status_then, status_then_at = status_on(data["changes"], payout_dt)
        contract = contract_value(job)
        coll_then = collected_by(data["payments"], payout_dt)
        coll_now = collected_total(data["payments"])

        rule = "Install" if r["kind"] in ("Install", "Demo + Install") else "Demo"
        if rule == "Install":
            flagged = (contract - coll_then) > OWED_TOLERANCE
            reason = "final payment not collected" if flagged else ""
        else:
            ratio_ok = contract > 0 and coll_then >= contract * DEMO_SECOND_PAYMENT_RATIO - OWED_TOLERANCE
            flagged = not ratio_ok and not second_payment_status(status_then)
            reason = "2nd payment not collected" if flagged else ""

        rec.update({
            "Job Name": job.get("name"),
            "Payout Date Used": payout_dt.date(),
            "Payout Date Source": "Nickel" if npd is not None else "Payroll sheet",
            "Status When Paid": status_then or "No status change on/before payout",
            "Status Since": status_then_at.date() if status_then_at else None,
            "Contract": contract,
            "Collected When Paid": coll_then,
            "Collected Now": coll_now,
            "Status Now": job.get("status_name"),
            "Rule Applied": rule,
            "Flagged": "YES" if flagged else "no",
            "Reason": reason,
            "Problem": "" if contract > 0 else "contract total is $0 in JobNimbus - check job",
        })
        out.append(rec)

    write_workbook(pd.DataFrame(out), pd.DataFrame(status_log), args.out)
    print(f"\nWrote {args.out}")


# =============================================================================
# Excel output
# =============================================================================
COLS = [
    "Job #", "Job Name", "Address (payroll)", "Sub", "Work Type", "Kind", "Rule Applied",
    "Payroll Date", "Payout Date Used", "Payout Date Source", "Payout Amount",
    "Status When Paid", "Status Since", "Contract", "Collected When Paid",
    "Owed When Paid", "Collected Now", "Owed Now", "Still Open?", "Status Now",
    "Flagged", "Reason", "Source", "Match Note", "Problem",
]
MONEY = {"Payout Amount", "Contract", "Collected When Paid", "Owed When Paid",
         "Collected Now", "Owed Now"}
DATES = {"Payroll Date", "Payout Date Used", "Status Since"}


def style_header(ws, ncols):
    fill = PatternFill("solid", fgColor="1F2937")
    for c in range(1, ncols + 1):
        cell = ws.cell(row=1, column=c)
        cell.font = Font(name=FONT, bold=True, color="FFFFFF")
        cell.fill = fill
        cell.alignment = Alignment(horizontal="center", vertical="center", wrap_text=True)
    ws.freeze_panes = "A2"
    ws.row_dimensions[1].height = 30


def write_payout_sheet(ws, df):
    ws.append(COLS)
    style_header(ws, len(COLS))
    col = {name: get_column_letter(i + 1) for i, name in enumerate(COLS)}
    flag_fill = PatternFill("solid", fgColor="FDE2E2")
    for i, (_, r) in enumerate(df.iterrows(), start=2):
        for j, name in enumerate(COLS, start=1):
            if name == "Owed When Paid":
                v = f"=IF({col['Contract']}{i}=\"\",\"\",{col['Contract']}{i}-{col['Collected When Paid']}{i})"
            elif name == "Owed Now":
                v = f"=IF({col['Contract']}{i}=\"\",\"\",{col['Contract']}{i}-{col['Collected Now']}{i})"
            elif name == "Still Open?":
                v = (f"=IF({col['Contract']}{i}=\"\",\"\",IF({col['Owed Now']}{i}>"
                     f"{OWED_TOLERANCE},\"YES\",\"no\"))")
            else:
                v = r.get(name)
                if isinstance(v, float) and pd.isna(v):
                    v = None
            cell = ws.cell(row=i, column=j, value=v)
            cell.font = Font(name=FONT)
            if name in MONEY:
                cell.number_format = '$#,##0.00;($#,##0.00);"-"'
            if name in DATES:
                cell.number_format = "mm/dd/yyyy"
        if r.get("Flagged") == "YES":
            for j in range(1, len(COLS) + 1):
                ws.cell(row=i, column=j).fill = flag_fill
    widths = {"Job Name": 34, "Address (payroll)": 34, "Sub": 30, "Status When Paid": 24,
              "Status Now": 22, "Reason": 26, "Match Note": 34, "Problem": 30}
    for name, letter in col.items():
        ws.column_dimensions[letter].width = widths.get(name, 14)
    if len(df):
        ws.auto_filter.ref = f"A1:{get_column_letter(len(COLS))}{len(df) + 1}"


def write_workbook(df, status_log, path):
    for c in COLS:
        if c not in df.columns:
            df[c] = None
    df = df.sort_values(["Payout Date Used", "Job #"], na_position="last")

    wb = Workbook()
    summ = wb.active
    summ.title = "Summary"
    flagged = wb.create_sheet("Flagged Payouts")
    allp = wb.create_sheet("All Payouts")
    unm = wb.create_sheet("Unmatched Rows")
    log = wb.create_sheet("Status Changes Log")

    write_payout_sheet(flagged, df[df["Flagged"] == "YES"])
    write_payout_sheet(allp, df)
    write_payout_sheet(unm, df[df["Problem"].fillna("").astype(str).str.len() > 0])

    # Status log
    log_cols = ["Job #", "Changed At (UTC)", "New Status", "Raw Note"]
    log.append(log_cols)
    style_header(log, len(log_cols))
    if len(status_log):
        status_log = status_log.sort_values(["Job #", "Changed At (UTC)"])
        for _, r in status_log.iterrows():
            t = r["Changed At (UTC)"]
            log.append([r["Job #"], t.replace(tzinfo=None) if t else None,
                        r["New Status"], r["Raw Note"]])
    for c, w in zip("ABCD", (10, 20, 30, 70)):
        log.column_dimensions[c].width = w
    for row in log.iter_rows(min_row=2):
        for cell in row:
            cell.font = Font(name=FONT)
        row[1].number_format = "mm/dd/yyyy hh:mm"

    # Summary (formulas against Flagged / All sheets)
    F = "'Flagged Payouts'"
    A = "'All Payouts'"
    cl = {name: get_column_letter(i + 1) for i, name in enumerate(COLS)}
    rows = [
        ("Payout Collection Audit", None),
        ("Generated", datetime.now().strftime("%m/%d/%Y %I:%M %p")),
        (None, None),
        ("Demo/Install payout lines reviewed", f"=COUNTA({A}!A:A)-1"),
        ("Flagged payout lines", f"=COUNTA({F}!A:A)-1"),
        ("  Install paid before final payment", f"=COUNTIF({F}!{cl['Rule Applied']}:{cl['Rule Applied']},\"Install\")"),
        ("  Demo paid before 2nd payment", f"=COUNTIF({F}!{cl['Rule Applied']}:{cl['Rule Applied']},\"Demo\")"),
        ("Flagged lines still open today", f"=COUNTIF({F}!{cl['Still Open?']}:{cl['Still Open?']},\"YES\")"),
        ("Flagged lines since collected", f"=COUNTIF({F}!{cl['Still Open?']}:{cl['Still Open?']},\"no\")"),
        (None, None),
        ("Sub $ paid on flagged lines", f"=SUM({F}!{cl['Payout Amount']}:{cl['Payout Amount']})"),
        ("Owed at time of payout (flagged)", f"=SUM({F}!{cl['Owed When Paid']}:{cl['Owed When Paid']})"),
        ("Owed today on flagged jobs (sum by line)", f"=SUMIF({F}!{cl['Still Open?']}:{cl['Still Open?']},\"YES\",{F}!{cl['Owed Now']}:{cl['Owed Now']})"),
        ("Rows needing review (Unmatched tab)", "=COUNTA('Unmatched Rows'!A:A)-1"),
        (None, None),
        ("Rules", None),
        ("Install flagged if", f"anything still owed at payout (> ${OWED_TOLERANCE:,.2f})"),
        ("Demo flagged if", f"< {DEMO_SECOND_PAYMENT_RATIO:.0%} of contract collected AND status not in: {', '.join(SECOND_PAYMENT_STATUSES)}"),
        ("Contract", "max(approved estimate total, approved invoice total) in JobNimbus"),
        ("Payout date", "Nickel paid date when --nickel CSV supplied and matched, else payroll sheet date"),
        ("Note", "A job with multiple flagged lines is counted once per line; filter 'Flagged Payouts' by Job # for unique jobs."),
    ]
    for i, (k, v) in enumerate(rows, start=1):
        summ.cell(row=i, column=1, value=k).font = Font(name=FONT, bold=(i in (1, 16)), size=14 if i == 1 else 10)
        c = summ.cell(row=i, column=2, value=v)
        c.font = Font(name=FONT)
        if i in (11, 12, 13):
            c.number_format = '$#,##0.00;($#,##0.00);"-"'
    summ.column_dimensions["A"].width = 42
    summ.column_dimensions["B"].width = 90

    wb.save(path)


# =============================================================================
# Probe (sanity check one job)
# =============================================================================
def probe(job_number):
    jn = JobNimbus(JN_BASE_URL, JN_API_KEY, use_cache=False)
    job = jn.job_by_number(job_number)
    if not job:
        sys.exit(f"Job {job_number} not found - check EP_JOBS / filter syntax.")
    print("JOB:", job.get("number"), job.get("name"), "|", job.get("status_name"),
          "| contract", contract_value(job))
    ch = jn.status_changes(job["jnid"])
    print(f"\nSTATUS CHANGES ({len(ch)}):")
    for a in ch[:15]:
        print("  ", ts(a.get("date_created")), "->", new_status_from_activity(a), "| raw:", a.get("note"))
    pays = jn.payments(job["jnid"])
    print(f"\nPAYMENTS ({len(pays)}):")
    for p in pays[:15]:
        print("  ", ts(p.get("date_payment")), paid_amount(p), p.get("reference"))
    print("\nIf status changes or payments are empty but the job clearly has them, adjust "
          "EP_ACTIVITIES / EP_PAYMENTS or the 'related.id' filter in the JobNimbus class.")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--crew", help="Copy_of_Crew_Payroll_Sheet.xlsx")
    ap.add_argument("--rhino", help="Rhino_Roofs___Payroll.xlsx")
    ap.add_argument("--nickel", help="optional CSV of paid Nickel bills (reference, paidDate, description)")
    ap.add_argument("--start", default=DEFAULT_START)
    ap.add_argument("--out", default="payout_collection_audit.xlsx")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--no-cache", action="store_true")
    ap.add_argument("--probe", help="job # to test API calls on")
    args = ap.parse_args()

    if args.probe:
        probe(args.probe)
        return
    if not args.crew and not args.rhino:
        ap.error("give --crew and/or --rhino")
    run(args)


if __name__ == "__main__":
    main()
