"""Reads and checks the uploaded file (the "Final_Report_for_DMS_Claim" format).

One row per NPSB transaction. KEY_ORG_NM is the partner (matched by name to Partner Configuration),
TXN_DIRECTION (Inward / Outward) picks the email template.
"""
import io
import re
from datetime import datetime
from decimal import Decimal, InvalidOperation

import pandas as pd

from .email_service import parse_direction

# Column key (header in lower case) -> header as written in the file
REQUIRED_COLUMNS = {
    "npsb_txn_rrn": "NPSB_TXN_RRN",
    "approval_date": "APPROVAL_DATE",
    "approval_datetime": "APPROVAL_DATETIME",
    "txn_type": "TXN_TYPE",
    "txn_id": "TXN_ID",
    "first_txn_status_name": "FIRST_TXN_STATUS_NAME",
    "txn_amount": "TXN_AMOUNT",
    "fromac_name": "FROMAC_NAME",
    "toac_type": "TOAC_TYPE",
    "org_txn_stan": "ORG_TXN_STAN",
    "key_org_nm": "KEY_ORG_NM",
    "npsb_org_code": "NPSB_ORG_CODE",
    "txn_direction": "TXN_DIRECTION",
}
# These must have a value in every row; the other columns must exist but may be empty
MUST_HAVE_VALUE = ("npsb_txn_rrn", "txn_amount", "key_org_nm", "txn_direction")
# Numbers that keep their leading zeros (Excel drops them when a cell is stored as a number)
ZERO_PADDED = {"org_txn_stan": 6, "npsb_org_code": 6}

SHEET_NAME = "Final_Report_for_DMS_Claim"

TEMPLATE_EXAMPLE_ROWS = [
    ["624515085655", "2026-09-02", "02-SEP-26 03.56.37.586000 PM", "NPSB - MFS to NAGAD", "00043BOS", "APPROVED",
     20500, "bKash", "CUSTOMER", "087542", "bKash", "022002", "Inward"],
    ["624516087002", "2026-09-02", "02-SEP-26 04.06.11.215000 PM", "Incoming payment from Bangla QR", "00043CPG",
     "APPROVED", 5000, "ABC Merchant", "MERCHANT", "088904", "bKash", "022002", "Inward"],
    ["624517090011", "2026-09-02", "02-SEP-26 05.12.40.100000 PM", "NPSB - NAGAD to MFS", "00043DQ1", "APPROVED",
     1500, "Customer Name", "CUSTOMER", "090011", "Rocket", "022001", "Outward"],
]
TEMPLATE_ROWS_WITH_DROPDOWN = 2000  # TXN_DIRECTION dropdown on this many rows


def build_template() -> bytes:
    """Sample .xlsx with the required headers, example rows and a TXN_DIRECTION dropdown."""
    from openpyxl import load_workbook
    from openpyxl.worksheet.datavalidation import DataValidation

    df = pd.DataFrame(TEMPLATE_EXAMPLE_ROWS, columns=list(REQUIRED_COLUMNS.values()))
    book = load_workbook(io.BytesIO(to_xlsx(df, SHEET_NAME)))
    sheet = book.active
    column = sheet.cell(row=1, column=list(REQUIRED_COLUMNS).index("txn_direction") + 1).column_letter
    dropdown = DataValidation(
        type="list", formula1='"Inward,Outward"', allow_blank=False,
        showErrorMessage=True, errorTitle="TXN_DIRECTION", error="Choose Inward or Outward.",
        showInputMessage=True, promptTitle="TXN_DIRECTION", prompt="Inward or Outward: picks the email template.",
    )
    dropdown.add(f"{column}2:{column}{TEMPLATE_ROWS_WITH_DROPDOWN + 1}")
    sheet.add_data_validation(dropdown)
    buffer = io.BytesIO()
    book.save(buffer)
    return buffer.getvalue()


def to_xlsx(df: pd.DataFrame, sheet_name: str = "Transactions") -> bytes:
    """DataFrame -> .xlsx bytes with sized columns and a frozen header row."""
    buffer = io.BytesIO()
    with pd.ExcelWriter(buffer, engine="openpyxl") as writer:
        df.to_excel(writer, index=False, sheet_name=sheet_name)
        sheet = writer.sheets[sheet_name]
        for column in sheet.columns:
            width = max(len(str(cell.value or "")) for cell in column) + 2
            sheet.column_dimensions[column[0].column_letter].width = min(width, 80)
        sheet.freeze_panes = "A2"
    return buffer.getvalue()


class FileValidationError(Exception):
    """Raised when the file as a whole can not be accepted."""

    def __init__(self, errors: list[str]):
        super().__init__("; ".join(errors))
        self.errors = errors


def _normalize_header(name) -> str:
    """'NPSB_TXN_RRN ' / 'Npsb Txn Rrn' -> 'npsb_txn_rrn'"""
    return re.sub(r"[\s_]+", "_", str(name).strip().lower())


def read_raw_file(filename: str, content: bytes) -> pd.DataFrame:
    """Load the file into a DataFrame where every cell is a string (headers as in the file)."""
    name = filename.lower()
    try:
        if name.endswith(".csv"):
            df = pd.read_csv(io.BytesIO(content), dtype=str, keep_default_na=False)
        elif name.endswith(".xlsx"):
            df = pd.read_excel(io.BytesIO(content), dtype=str, keep_default_na=False)
        else:
            raise FileValidationError(["Only .xlsx and .csv files are allowed."])
    except FileValidationError:
        raise
    except Exception as exc:
        raise FileValidationError([f"Could not read the file: {exc}"])
    return df


def read_file(filename: str, content: bytes) -> pd.DataFrame:
    """Same as read_raw_file, with headers normalized ('NPSB_TXN_RRN' -> 'npsb_txn_rrn')."""
    df = read_raw_file(filename, content)
    df.columns = [_normalize_header(c) for c in df.columns]
    return df


def _clean_number_text(value: str) -> str:
    """'624515085655.0' (a number cell) -> '624515085655'"""
    return value[:-2] if re.fullmatch(r"\d+\.0", value) else value


def parse_approval_datetime(text: str) -> datetime | None:
    """'02-SEP-26 03.56.37.586000 PM' (Oracle export) or any normal date/time -> datetime."""
    text = text.strip()
    for fmt in ("%d-%b-%y %I.%M.%S.%f %p", "%d-%b-%y %I.%M.%S %p", "%d-%b-%Y %I.%M.%S.%f %p"):
        try:
            return datetime.strptime(text.upper().title(), fmt)
        except ValueError:
            continue
    parsed = pd.to_datetime(text, errors="coerce", dayfirst=True)
    return None if pd.isna(parsed) else parsed.to_pydatetime()


def parse_transactions(filename: str, content: bytes):
    """Returns (total_rows, valid_rows, row_errors).

    valid_rows -> list of dicts ready to save as Transaction
    row_errors -> list of {"row": excel_row_number, "rrn": ..., "errors": [...]}
    """
    df = read_file(filename, content)

    missing = [label for col, label in REQUIRED_COLUMNS.items() if col not in df.columns]
    if missing:
        raise FileValidationError(["Missing required column(s): " + ", ".join(missing)])
    if df.empty:
        raise FileValidationError(["The file has no transaction rows."])

    valid_rows, row_errors = [], []
    first_row_of_rrn: dict[str, int] = {}

    for index, row in df.iterrows():
        excel_row = index + 2  # +1 for header, +1 because Excel starts at 1
        values = {col: _clean_number_text(str(row[col]).strip()) for col in REQUIRED_COLUMNS}
        for col, width in ZERO_PADDED.items():
            if values[col].isdigit():
                values[col] = values[col].zfill(width)
        errors = []

        # 1) the columns every row needs
        for col in MUST_HAVE_VALUE:
            if values[col] == "":
                errors.append(f"{REQUIRED_COLUMNS[col]} is blank")

        # 2) an RRN only once per file
        rrn = values["npsb_txn_rrn"]
        if rrn and rrn in first_row_of_rrn:
            errors.append(f"NPSB_TXN_RRN {rrn} is already in row {first_row_of_rrn[rrn]}")
        elif rrn:
            first_row_of_rrn[rrn] = excel_row

        # 3) direction: Inward or Outward, it picks the email template
        mail_type = parse_direction(values["txn_direction"]) if values["txn_direction"] else None
        if values["txn_direction"] and mail_type is None:
            errors.append(f"TXN_DIRECTION '{values['txn_direction']}' must be Inward or Outward")

        # 4) amount must be a positive number
        amount = None
        if values["txn_amount"]:
            try:
                amount = Decimal(values["txn_amount"].replace(",", ""))
                if amount <= 0:
                    errors.append("TXN_AMOUNT must be greater than 0")
            except InvalidOperation:
                errors.append(f"TXN_AMOUNT '{values['txn_amount']}' is not a number")

        # 5) when: APPROVAL_DATETIME, or at least APPROVAL_DATE
        txn_datetime = parse_approval_datetime(values["approval_datetime"]) if values["approval_datetime"] else None
        approval_date = None
        if values["approval_date"]:
            parsed = pd.to_datetime(values["approval_date"], errors="coerce")
            approval_date = None if pd.isna(parsed) else parsed.date()
            if approval_date is None:
                errors.append(f"APPROVAL_DATE '{values['approval_date']}' is not a valid date")
        if values["approval_datetime"] and txn_datetime is None:
            errors.append(f"APPROVAL_DATETIME '{values['approval_datetime']}' is not a valid date/time")
        if not values["approval_datetime"] and not values["approval_date"]:
            errors.append("APPROVAL_DATE and APPROVAL_DATETIME are both blank")
        if txn_datetime is None and approval_date is not None:
            txn_datetime = datetime.combine(approval_date, datetime.min.time())
        if approval_date is None and txn_datetime is not None:
            approval_date = txn_datetime.date()

        if errors:
            row_errors.append({"row": excel_row, "rrn": rrn, "errors": errors})
            continue

        valid_rows.append({
            "excel_row": excel_row,
            "rrn": rrn,
            "approval_date": approval_date,
            "approval_datetime_text": values["approval_datetime"] or None,
            "txn_datetime": txn_datetime,
            "txn_type": values["txn_type"],
            "txn_id": values["txn_id"] or None,
            "status": values["first_txn_status_name"],
            "amount": amount,
            "from_account_name": values["fromac_name"] or None,
            "to_account_type": values["toac_type"] or None,
            "stan": values["org_txn_stan"],
            "partner_name": values["key_org_nm"],
            "org_code": values["npsb_org_code"],
            "mail_type": mail_type,
        })

    return len(df), valid_rows, row_errors


def split_rows(filename: str, content: bytes) -> tuple[pd.DataFrame, pd.DataFrame]:
    """Returns (valid, faulty) rows of the file, with the file's own columns and values.

    faulty also gets an "Excel Row" column (first) with the row number in the original file.
    """
    _, _, row_errors = parse_transactions(filename, content)
    df = read_raw_file(filename, content)
    faulty_index = [r["row"] - 2 for r in row_errors]  # Excel row -> DataFrame index

    valid = df.drop(index=faulty_index)
    faulty = df.loc[faulty_index].copy()
    faulty.insert(0, "Excel Row", [i + 2 for i in faulty.index])
    return valid, faulty
