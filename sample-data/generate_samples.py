"""Generates the dummy upload files in this folder.

Run:  python generate_samples.py
Creates:
  dispute_transactions_sample.xlsx  -> valid file (2 rows have problems on purpose)
  dispute_transactions_sample.csv   -> same data as CSV
  invalid_missing_columns.xlsx      -> rejected because columns are missing
"""
import random
from datetime import datetime, timedelta

import pandas as pd

random.seed(7)

PARTNERS = [
    ("0101", "bKash", "wallet"),
    ("0102", "Rocket (DBBL)", "wallet"),
    ("0201", "BRAC Bank", "account"),
    ("0202", "Islami Bank Bangladesh", "account"),
    ("0203", "The City Bank", "account"),
    ("0301", "Upay", "wallet"),
]
UNKNOWN_CODES = ["68", "91", "96"]   # unknown outcome -> needs clarification
KNOWN_CODES = ["00", "05", "51"]     # success / declined -> ignored by the system
TXN_TYPES = ["Fund Transfer (P2P)", "Add Money", "Send Money to Bank"]


def wallet():
    return "01" + random.choice("3456789") + "".join(random.choices("0123456789", k=8))


def account():
    return "".join(random.choices("0123456789", k=13))


rows = []
start = datetime(2026, 10, 17, 8, 0, 0)
for i in range(32):
    code, name, kind = PARTNERS[i % len(PARTNERS)]  # every partner gets rows
    unknown = i % 4 != 3                 # ~75% of rows have an unknown code
    resp = random.choice(UNKNOWN_CODES if unknown else KNOWN_CODES)
    status = "PENDING" if unknown else ("SUCCESS" if resp == "00" else "FAILED")
    rows.append({
        "Txn Datetime": start + timedelta(minutes=random.randint(0, 900)),
        "RRN": str(629017000000 + random.randint(100000, 999999)),
        "STAN": str(random.randint(100000, 999999)),
        "Amount": random.choice([500, 1000, 1500, 2500, 5000, 7500, 10000, 25000]) + random.choice([0, 0, 50.5]),
        "Source Account": wallet(),
        "Beneficiary Account": wallet() if kind == "wallet" else account(),
        "Txn Type": random.choice(TXN_TYPES),
        "Response Code": resp,
        "Nagad Status": status,
        "Dest Institution Code": code,
        "Dest Partner Name": name,
    })

rows.sort(key=lambda r: r["Txn Datetime"])

# two broken rows to show row-level validation (they are skipped, others still work)
rows[5]["RRN"] = ""                    # blank RRN
rows[12]["Amount"] = "abc"             # not a number

df = pd.DataFrame(rows)
df.to_excel("dispute_transactions_sample.xlsx", index=False)

csv_df = df.copy()
csv_df["Txn Datetime"] = csv_df["Txn Datetime"].dt.strftime("%Y-%m-%d %H:%M:%S")
csv_df.to_csv("dispute_transactions_sample.csv", index=False)

# a file missing STAN and Response Code -> the whole file is rejected
df.drop(columns=["STAN", "Response Code"]).head(5).to_excel("invalid_missing_columns.xlsx", index=False)

print(f"Created {len(df)} rows. Unknown-code rows: {df['Response Code'].isin(UNKNOWN_CODES).sum()}")
