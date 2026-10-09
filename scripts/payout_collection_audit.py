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
  - Optional: pass --nickel with Nickel's transactions export (Date, Payee/Vendor,
    Amount, Status, Reference). A payroll line takes the date of the Nickel payable
    to the same vendor for the same amount paid near the payroll date. A bills CSV
    with reference (job #) + paidDate columns also works.

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

  python payout_collection_audit.py ... --jn-dump DIR  # use jobs.json / payments.json /
                                                     # status_changes.json instead of the API
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

# Nickel "transactions" export: a payroll line matches a Nickel payable to the same
# vendor for the same amount (+/- NICKEL_AMOUNT_TOLERANCE), paid between
# NICKEL_DAYS_BEFORE before and NICKEL_DAYS_AFTER after the payroll date.
NICKEL_AMOUNT_TOLERANCE = 1.00
NICKEL_DAYS_BEFORE = 7
NICKEL_DAYS_AFTER = 30
# Payroll sub names that share no word with their Nickel vendor name.
NICKEL_VENDOR_ALIASES = {"victor": "lion king", "favian": "lf gutters"}
VENDOR_STOPWORDS = {"llc", "inc", "corp", "roofing", "construction", "services", "service",
                    "repairs", "group", "and", "more", "dba"}

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


class OfflineJobNimbus:
    """Same interface as JobNimbus, backed by JSON dumps in one folder:
    jobs.json, payments.json, status_changes.json (lists of JobNimbus records,
    e.g. pulled through the JobNimbus MCP connector when no API key is at hand)."""

    def __init__(self, dump_dir):
        def load(name):
            with open(os.path.join(dump_dir, name)) as f:
                return json.load(f)
        self.jobs = load("jobs.json")
        self.by_number = {str(j.get("number")): j for j in self.jobs}
        self._payments, self._changes = {}, {}
        for p in load("payments.json"):
            for rel in p.get("related") or []:
                if rel.get("type") == "job":
                    self._payments.setdefault(rel["id"], []).append(p)
        for a in load("status_changes.json"):
            prim = a.get("primary") or {}
            if prim.get("type") == "job":
                self._changes.setdefault(prim["id"], []).append(a)

    def job_by_number(self, number):
        return self.by_number.get(str(number))

    def status_changes(self, jnid):
        return self._changes.get(jnid, [])

    def payments(self, jnid):
        return self._payments.get(jnid, [])

    def all_jobs_light(self):
        return self.jobs


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
    s = re.sub(r"^\s*(\d+)\s*-\s*\d+\b", r"\1", s)   # building ranges "8024 - 8038 X" -> "8024 X"
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

    @staticmethod
    def _score(target, cand):
        """Similarity, also comparing only the first words of the payroll address
        (payroll often appends city / state / zip that JobNimbus keeps elsewhere)."""
        tt, ct = target.split(), cand.split()
        if len(tt) < 2 or len(ct) < 2:
            return 0.0
        full = difflib.SequenceMatcher(None, target, cand).ratio()
        prefix = difflib.SequenceMatcher(None, " ".join(tt[:len(ct)]), cand).ratio()
        return max(full, prefix)

    def match(self, address, as_of=None):
        hn = house_number(address)
        if not hn or hn not in self.by_num:
            return None, 0.0, "no job with that house number"
        target = norm_addr(address)
        scored = [(self._score(target, n), j) for n, j in self.by_num[hn]]
        best_score = max(s for s, _ in scored)
        if best_score < ADDRESS_MATCH_CUTOFF:
            return None, best_score, "address similarity below cutoff"
        close = [j for s, j in scored if s >= best_score - 0.02]
        nums = sorted({str(j.get("number")) for j in close})
        if len(nums) == 1:
            return close[0], best_score, "ok"
        # same address on several jobs: most recent job created on/before the payout
        cutoff = as_of.timestamp() + 86400 if as_of is not None else float("inf")
        before = [j for j in close if (j.get("date_created") or 0) < cutoff] or close
        best = max(before, key=lambda j: j.get("date_created") or 0)
        return best, best_score, f"ambiguous ({', '.join(nums)}) - picked most recent before payout"


# =============================================================================
# Nickel paid-date matching (optional)
# =============================================================================
def vendor_words(name):
    words = re.sub(r"[^a-z0-9 ]", "", str(name).lower().replace("/", " ").replace("-", " ")).split()
    return {w for w in words if len(w) >= 3 and w not in VENDOR_STOPWORDS}


def load_nickel(path):
    """Accepts either Nickel's transactions export (Date, Payee/Vendor, Amount, Status,
    Reference) or a bills CSV with reference + paidDate columns (job # in reference)."""
    if not path:
        return None
    n = pd.read_csv(path)
    cols = {c.lower(): c for c in n.columns}
    if "payee/vendor" in cols and "amount" in cols:
        n = n[n[cols["type"]].eq("Payable")
              & n[cols["status"]].isin(["COMPLETED", "SENT", "DELIVERED"])].copy()
        n["_vendor"] = n[cols["payee/vendor"]].astype(str)
        n["_amt"] = pd.to_numeric(n[cols["amount"]].astype(str).str.replace(r"[$,]", "", regex=True),
                                  errors="coerce")
        n["_paid"] = pd.to_datetime(n[cols["date"]], errors="coerce")
        n["_ref"] = n[cols["reference"]].astype(str)
        n["_words"] = n["_vendor"].map(vendor_words)
        n.attrs["format"] = "transactions"
        return n.dropna(subset=["_amt", "_paid"]).reset_index(drop=True)
    ref = cols.get("reference")
    paid = cols.get("paiddate") or cols.get("paid_date") or cols.get("paid date")
    if not ref or not paid:
        sys.exit("Nickel CSV needs either Payee/Vendor + Amount + Date columns "
                 "or 'reference' and 'paidDate' columns.")
    n["_job"] = n[ref].astype(str).str.extract(r"^\s*(\d{3,6})")[0]
    n["_paid"] = pd.to_datetime(n[paid], errors="coerce")
    desc = cols.get("description")
    n["_desc"] = n[desc].astype(str).str.lower() if desc else ""
    n.attrs["format"] = "bills"
    return n.dropna(subset=["_job", "_paid"])


def nickel_match(nickel, row, used):
    """(paid date, note) of the Nickel payment for one payroll line, or (None, reason).
    `used` holds Nickel row indexes already matched, so one payment is used once."""
    if nickel is None:
        return None, ""
    payroll_date = row["payroll_date"]
    if nickel.attrs.get("format") == "transactions":
        sub = str(row["sub"]).lower()
        want = vendor_words(sub)
        want |= {w for k, v in NICKEL_VENDOR_ALIASES.items() if k in sub for w in vendor_words(v)}
        c = nickel[(~nickel.index.isin(used))
                   & ((nickel["_amt"] - row["amount"]).abs() <= NICKEL_AMOUNT_TOLERANCE)
                   & (nickel["_paid"] >= payroll_date - pd.Timedelta(days=NICKEL_DAYS_BEFORE))
                   & (nickel["_paid"] <= payroll_date + pd.Timedelta(days=NICKEL_DAYS_AFTER))]
        c = c[c["_words"].map(lambda w: bool(w & want))]
        if c.empty:
            return None, "no Nickel payment with same vendor + amount"
        i = (c["_paid"] - payroll_date).abs().idxmin()
        used.add(i)
        return c.at[i, "_paid"], f"{c.at[i, '_vendor']} ${c.at[i, '_amt']:,.2f} ref: {c.at[i, '_ref']}"
    job_number = row["job_number"]
    if not job_number:
        return None, ""
    c = nickel[nickel["_job"] == str(job_number)].copy()
    word = "demo" if row["kind"] == "Demo" else "install"
    pref = c[c["_desc"].str.contains(word, na=False)]
    if not pref.empty:
        c = pref
    c["_gap"] = (c["_paid"] - payroll_date).abs()
    c = c[c["_gap"] <= pd.Timedelta(days=NICKEL_MATCH_WINDOW_DAYS)]
    if c.empty:
        return None, "no Nickel bill for job # near payroll date"
    return c.sort_values("_gap").iloc[0]["_paid"], "bill for job #"


# =============================================================================
# Status / payment helpers
# =============================================================================
# JobNimbus writes job status changes as either "Job Updated\nStatus: A => B" or
# "Status changed from A to B". Names can contain " to " ("Job to be Scheduled"),
# so the second form is resolved against the account's known status names.
STATUS_ARROW_RE = re.compile(r"^Status: .*? => (.+?)\s*$", re.MULTILINE)
STATUS_FROM_TO_RE = re.compile(r"^Status changed from (.+)$", re.MULTILINE)
KNOWN_STATUSES = set()


def ts(v):
    """JobNimbus epoch seconds -> UTC datetime."""
    try:
        return datetime.fromtimestamp(int(v), tz=timezone.utc)
    except (TypeError, ValueError):
        return None


def new_status_from_activity(a):
    """New status name, or None when the activity is not a job status change."""
    for k in ("status_name_new", "new_status_name", "status_name"):
        if a.get(k):
            return str(a[k])
    note = str(a.get("note") or "")
    m = STATUS_ARROW_RE.search(note)
    if m:
        return m.group(1).strip()
    m = STATUS_FROM_TO_RE.search(note)
    if m:
        parts = m.group(1).split(" to ")
        tails = [" to ".join(parts[i:]).strip().rstrip(".") for i in range(1, len(parts))]
        known = [t for i, t in enumerate(tails)
                 if t in KNOWN_STATUSES or " to ".join(parts[:i + 1]) in KNOWN_STATUSES]
        return known[0] if known else (tails[-1] if tails else None)
    return None


def learn_status_names(changes):
    """Add the unambiguous "A => B" names to KNOWN_STATUSES."""
    for a in changes:
        for m in re.finditer(r"^Status: (.+?) => (.+?)\s*$", str(a.get("note") or ""), re.MULTILINE):
            KNOWN_STATUSES.update((m.group(1).strip(), m.group(2).strip()))


def status_on(changes, when):
    """Latest status change on/before `when` (end of that day)."""
    cutoff = when.replace(tzinfo=timezone.utc) + timedelta(days=1)
    best_t, best_s = None, None
    for a in changes:
        t = ts(a.get("date_created"))
        status = new_status_from_activity(a)
        if status and t and t < cutoff and (best_t is None or t > best_t):
            best_t, best_s = t, status
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


def date_collected_reached(payments, amount):
    """UTC date the running collected total first reached `amount`, or None."""
    running = 0.0
    dated = [(ts(p.get("date_payment")) or ts(p.get("date_created")), paid_amount(p))
             for p in payments if p.get("is_active", True)]
    for t, amt in sorted((d for d in dated if d[0]), key=lambda d: d[0]):
        running += amt
        if running >= amount:
            return t.date()
    return None


def is_financed(payments, contract):
    """Paid by a lender: a payment referenced 'finance', or one payment covering ~all of it."""
    active = [p for p in payments if p.get("is_active", True)]
    if any("financ" in str(p.get("reference") or "").lower() for p in active):
        return True
    return contract > 0 and len(active) == 1 and paid_amount(active[0]) >= contract * 0.9


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

    if args.jn_dump:
        jn = OfflineJobNimbus(args.jn_dump)
        KNOWN_STATUSES.update(j.get("status_name") for j in jn.jobs if j.get("status_name"))
        for changes in jn._changes.values():
            learn_status_names(changes)
    else:
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
            job, score, note = idx.match(r["address"], r["payroll_date"])
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
        learn_status_names(changes)
        pays = jn.payments(jnid)
        job_cache[num] = {"job": job, "changes": changes, "payments": pays}
        for a in changes:
            if not new_status_from_activity(a):
                continue
            status_log.append({
                "Job #": num,
                "Changed At (UTC)": ts(a.get("date_created")),
                "New Status": new_status_from_activity(a),
                "Raw Note": a.get("note"),
            })
        print(f"  {num}: {len(changes)} status changes, {len(pays)} payments")

    # --- evaluate each payout -----------------------------------------------
    out, nickel_used = [], set()
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
        npd, nickel_note = nickel_match(nickel, r, nickel_used)
        payout_dt = (npd if npd is not None else r["payroll_date"]).to_pydatetime()
        status_then, status_then_at = status_on(data["changes"], payout_dt)
        contract = contract_value(job)
        coll_then = collected_by(data["payments"], payout_dt)
        coll_now = collected_total(data["payments"])

        rule = "Install" if r["kind"] in ("Install", "Demo + Install") else "Demo"
        needed = (contract - OWED_TOLERANCE if rule == "Install"
                  else contract * DEMO_SECOND_PAYMENT_RATIO - OWED_TOLERANCE)
        met_on = date_collected_reached(data["payments"], needed) if contract > 0 else None
        checks = []
        if (str(job.get("status_name") or "").lower() in ("paid & closed", "final invoice paid")
                and contract - coll_now > OWED_TOLERANCE):
            checks.append("status says paid but JobNimbus payments don't add up to contract")
        if (rule == "Install" and second_payment_status(status_then)
                and "2nd payment" not in str(status_then).lower() and contract - coll_then > OWED_TOLERANCE):
            checks.append("status said paid at payout but payment dated later")
        if rule == "Install":
            flagged = (contract - coll_then) > OWED_TOLERANCE
            reason = "final payment not collected" if flagged else ""
        else:
            ratio_ok = contract > 0 and coll_then >= contract * DEMO_SECOND_PAYMENT_RATIO - OWED_TOLERANCE
            flagged = not ratio_ok and not second_payment_status(status_then)
            reason = "2nd payment not collected" if flagged else ""

        rec.update({
            "Job Name": job.get("name") or ", ".join(x for x in (job.get("address_line1"), job.get("city")) if x),
            "Payout Date Used": payout_dt.date(),
            "Payout Date Source": "Nickel" if npd is not None else "Payroll sheet",
            "Nickel Match": nickel_note,
            "Status When Paid": status_then or "No status change on/before payout",
            "Status Since": status_then_at.date() if status_then_at else None,
            "Contract": contract,
            "Collected When Paid": coll_then,
            "Collected Now": coll_now,
            "Status Now": job.get("status_name"),
            "Rule Applied": rule,
            "Threshold Met On": met_on,
            "Days Paid Early": (met_on - payout_dt.date()).days if met_on and met_on > payout_dt.date() else None,
            "Financed": "YES" if is_financed(data["payments"], contract) else "",
            "Data Check": "; ".join(checks),
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
    "Flagged", "Reason", "Threshold Met On", "Days Paid Early", "Financed", "Data Check",
    "Source", "Match Note", "Nickel Match", "Problem",
]
MONEY = {"Payout Amount", "Contract", "Collected When Paid", "Owed When Paid",
         "Collected Now", "Owed Now"}
DATES = {"Payroll Date", "Payout Date Used", "Status Since", "Threshold Met On"}


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
              "Status Now": 22, "Reason": 26, "Match Note": 34, "Nickel Match": 40,
              "Problem": 30, "Data Check": 40}
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
        ("Demo/Install payout lines reviewed", f"=COUNTA({A}!{cl['Kind']}:{cl['Kind']})-1"),
        ("Flagged payout lines", f"=COUNTA({F}!{cl['Kind']}:{cl['Kind']})-1"),
        ("  Install paid before final payment", f"=COUNTIF({F}!{cl['Rule Applied']}:{cl['Rule Applied']},\"Install\")"),
        ("  Demo paid before 2nd payment", f"=COUNTIF({F}!{cl['Rule Applied']}:{cl['Rule Applied']},\"Demo\")"),
        ("Flagged lines still open today", f"=COUNTIF({F}!{cl['Still Open?']}:{cl['Still Open?']},\"YES\")"),
        ("Flagged lines since collected", f"=COUNTIF({F}!{cl['Still Open?']}:{cl['Still Open?']},\"no\")"),
        ("  of those, collected within 7 days of payout", f"=COUNTIFS({F}!{cl['Days Paid Early']}:{cl['Days Paid Early']},\"<=7\",{F}!{cl['Still Open?']}:{cl['Still Open?']},\"no\")"),
        ("Flagged lines on financed jobs", f"=COUNTIF({F}!{cl['Financed']}:{cl['Financed']},\"YES\")"),
        ("Flagged lines with a data check note", f"=COUNTIF({F}!{cl['Data Check']}:{cl['Data Check']},\"?*\")"),
        (None, None),
        ("Sub $ paid on flagged lines", f"=SUM({F}!{cl['Payout Amount']}:{cl['Payout Amount']})"),
        ("Owed at time of payout (flagged)", f"=SUM({F}!{cl['Owed When Paid']}:{cl['Owed When Paid']})"),
        ("Owed today on flagged jobs (sum by line)", f"=SUMIF({F}!{cl['Still Open?']}:{cl['Still Open?']},\"YES\",{F}!{cl['Owed Now']}:{cl['Owed Now']})"),
        ("Rows needing review (Unmatched tab)", f"=COUNTA('Unmatched Rows'!{cl['Kind']}:{cl['Kind']})-1"),
        (None, None),
        ("Rules", None),
        ("Install flagged if", f"anything still owed at payout (> ${OWED_TOLERANCE:,.2f})"),
        ("Demo flagged if", f"< {DEMO_SECOND_PAYMENT_RATIO:.0%} of contract collected AND status not in: {', '.join(SECOND_PAYMENT_STATUSES)}"),
        ("Contract", "max(approved estimate total, approved invoice total) in JobNimbus"),
        ("Payout date", "Nickel paid date when --nickel CSV supplied and matched (same vendor + amount), else payroll sheet date"),
        ("Note", "A job with multiple flagged lines is counted once per line; filter 'Flagged Payouts' by Job # for unique jobs."),
    ]
    money_rows = {"Sub $ paid on flagged lines", "Owed at time of payout (flagged)",
                  "Owed today on flagged jobs (sum by line)"}
    for i, (k, v) in enumerate(rows, start=1):
        summ.cell(row=i, column=1, value=k).font = Font(name=FONT, bold=k in ("Payout Collection Audit", "Rules"),
                                                         size=14 if i == 1 else 10)
        c = summ.cell(row=i, column=2, value=v)
        c.font = Font(name=FONT)
        if k in money_rows:
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
    ap.add_argument("--jn-dump", help="folder with jobs.json / payments.json / status_changes.json "
                                      "to use instead of calling the JobNimbus API")
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
