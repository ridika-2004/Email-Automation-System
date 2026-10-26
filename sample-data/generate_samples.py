"""Generates test upload files in the "Final_Report_for_DMS_Claim" format (next to the real
inward report Successful_at_Nagad_not_found_in_OIC_Dated_02-09-2026.xlsx).

Run:  python generate_samples.py
Creates:
  sample_outward_transactions.xlsx  -> Outward rows for a few partners (2 rows have problems on purpose)
  invalid_missing_columns.xlsx      -> rejected because columns are missing
"""
import random
from datetime import datetime, timedelta

import pandas as pd

random.seed(7)

COLUMNS = ["NPSB_TXN_RRN", "APPROVAL_DATE", "APPROVAL_DATETIME", "TXN_TYPE", "TXN_ID", "FIRST_TXN_STATUS_NAME",
           "TXN_AMOUNT", "FROMAC_NAME", "TOAC_TYPE", "ORG_TXN_STAN", "KEY_ORG_NM", "NPSB_ORG_CODE", "TXN_DIRECTION"]
PARTNERS = [("bKash", "022002"), ("Rocket", "022001"), ("TallyPay", "031005"), ("UPAY", "022005")]
NAMES = ["Rahim Uddin", "Karim Ahmed", "Nusrat Jahan", "Tania Akter", "Sabbir Hossain", "Mitu Rani"]

day = datetime(2026, 9, 2)
rows = []
for i in range(20):
    partner, code = PARTNERS[i % len(PARTNERS)]
    when = day + timedelta(hours=9, seconds=random.randint(0, 9 * 3600), microseconds=random.randint(0, 999) * 1000)
    rows.append({
        "NPSB_TXN_RRN": str(624600090000 + i * 7),
        "APPROVAL_DATE": day,
        "APPROVAL_DATETIME": when.strftime("%d-%b-%y %I.%M.%S.%f %p").upper(),
        "TXN_TYPE": "NPSB - NAGAD to MFS",
        "TXN_ID": f"00051{random.randint(100, 999)}X",
        "FIRST_TXN_STATUS_NAME": "APPROVED",
        "TXN_AMOUNT": random.choice([200, 500, 1000, 1500, 2500, 5000]),
        "FROMAC_NAME": random.choice(NAMES),
        "TOAC_TYPE": "CUSTOMER",
        "ORG_TXN_STAN": f"{random.randint(0, 999999):06d}",
        "KEY_ORG_NM": partner,
        "NPSB_ORG_CODE": code,
        "TXN_DIRECTION": "Outward",
    })

# two broken rows to show row-level validation (they are skipped, the others still work)
rows[5]["NPSB_TXN_RRN"] = ""          # blank RRN
rows[12]["TXN_AMOUNT"] = "abc"        # not a number

df = pd.DataFrame(rows, columns=COLUMNS)
with pd.ExcelWriter("sample_outward_transactions.xlsx", engine="openpyxl") as writer:
    df.to_excel(writer, index=False, sheet_name="Final_Report_for_DMS_Claim")

# missing TXN_ID and TXN_DIRECTION -> the whole file is rejected
df.drop(columns=["TXN_ID", "TXN_DIRECTION"]).head(5).to_excel("invalid_missing_columns.xlsx", index=False)

print(f"Created sample_outward_transactions.xlsx ({len(df)} rows) and invalid_missing_columns.xlsx")
