import io
from datetime import datetime
from decimal import Decimal, InvalidOperation

import pandas as pd

from .config import UNKNOWN_RESPONSE_CODES


REQUIRED_COLUMNS = {
    "txn_datetime": "Transaction Date & Time",
    "rrn": "RRN",
    "stan": "STAN",
    "amount": "Amount",
    "source_account": "Source Account / Wallet",
    "beneficiary_account": "Beneficiary Account / Wallet",
    "txn_type": "Transaction Type",
    "response_code": "Response Code",
    "nagad_status": "Status at Nagad",
    "dest_institution_code": "Destination Institution Code",
    "dest_partner_name": "Destination Partner Name",
}


# Header text used in the downloadable template (normalizes to the keys above)
TEMPLATE_HEADERS = {
    "txn_datetime": "Txn Datetime",
    "rrn": "RRN",
    "stan": "STAN",
    "amount": "Amount",
    "source_account": "Source Account",
    "beneficiary_account": "Beneficiary Account",
    "txn_type": "Txn Type",
    "response_code": "Response Code",
    "nagad_status": "Nagad Status",
    "dest_institution_code": "Dest Institution Code",
    "dest_partner_name": "Dest Partner Name",
}

TEMPLATE_EXAMPLE_ROWS = [
    ["2026-10-17 09:15:00", "629017123456", "123456", 1500, "01712345678", "01898765432",
     "Fund Transfer (P2P)", "68", "PENDING", "0101", "ABC Wallet"],
    ["2026-10-17 10:42:30", "629017654321", "654321", 25000, "01612345678", "1234567890123",
     "Send Money to Bank", "91", "PENDING", "0201", "XYZ Bank"],
]


def build_template() -> bytes:
    """Sample .xlsx with the required headers and two example rows."""
    df = pd.DataFrame(TEMPLATE_EXAMPLE_ROWS, columns=[TEMPLATE_HEADERS[c] for c in REQUIRED_COLUMNS])
    return to_xlsx(df)


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
    """'Response Code ' -> 'response_code'"""
    return str(name).strip().lower().replace(" ", "_")


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
    """Same as read_raw_file, with headers normalized ('Response Code' -> 'response_code')."""
    df = read_raw_file(filename, content)
    df.columns = [_normalize_header(c) for c in df.columns]
    return df


def parse_transactions(filename: str, content: bytes):
    """Returns (total_rows, valid_rows, row_errors).

    valid_rows -> list of dicts ready to save as Transaction
    row_errors -> list of {"row": excel_row_number, "errors": [...]}
    """
    df = read_file(filename, content)

    missing = [label + f" ({col})" for col, label in REQUIRED_COLUMNS.items() if col not in df.columns]
    if missing:
        raise FileValidationError(["Missing required column(s): " + ", ".join(missing)])
    if df.empty:
        raise FileValidationError(["The file has no transaction rows."])

    valid_rows, row_errors = [], []

    for index, row in df.iterrows():
        excel_row = index + 2  # +1 for header, +1 because Excel starts at 1
        values = {col: str(row[col]).strip() for col in REQUIRED_COLUMNS}
        errors = []

        # 1) blank checks
        for col, label in REQUIRED_COLUMNS.items():
            if values[col] == "":
                errors.append(f"{label} is blank")

        # 2) amount must be a positive number
        amount = None
        if values["amount"]:
            try:
                amount = Decimal(values["amount"].replace(",", ""))
                if amount <= 0:
                    errors.append("Amount must be greater than 0")
            except InvalidOperation:
                errors.append(f"Amount '{values['amount']}' is not a number")

        # 3) date must be a valid date/time
        txn_datetime = None
        if values["txn_datetime"]:
            parsed = pd.to_datetime(values["txn_datetime"], errors="coerce")
            if pd.isna(parsed):
                errors.append(f"Date '{values['txn_datetime']}' is not a valid date/time")
            else:
                txn_datetime = parsed.to_pydatetime()

        if errors:
            row_errors.append({"row": excel_row, "rrn": values["rrn"], "errors": errors})
            continue

        response_code = values["response_code"].upper()
        valid_rows.append({
            "excel_row": excel_row,
            "txn_datetime": txn_datetime,
            "rrn": values["rrn"],
            "stan": values["stan"],
            "amount": amount,
            "source_account": values["source_account"],
            "beneficiary_account": values["beneficiary_account"],
            "txn_type": values["txn_type"],
            "response_code": response_code,
            "nagad_status": values["nagad_status"],
            "dest_institution_code": values["dest_institution_code"],
            "dest_partner_name": values["dest_partner_name"],
            "is_unknown": response_code in UNKNOWN_RESPONSE_CODES,
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
