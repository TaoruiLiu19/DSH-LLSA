"""CSV parsing, timestamp deduplication, and independent verification."""
import csv
import hashlib
import io
import re
from dataclasses import dataclass
from datetime import datetime, timezone

MAX_BYTES = 16 * 1024 * 1024
MAX_ROWS = 100_000
MAX_COLUMNS = 128
KEEP_MODES = ("last_row", "latest_timestamp")
TIMESTAMP = re.compile(
    r"\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?"
    r"(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)?\Z"
)


class TaskError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code
        self.message = message


def error_receipt(error):
    result = {"status": "error", "code": error.code, "message": error.message}
    for name in ("step", "column", "columns"):
        if getattr(error, name, None) is not None:
            result[name] = getattr(error, name)
    return result


def digest(data):
    return hashlib.sha256(data).hexdigest()


@dataclass
class Table:
    columns: list
    rows: list
    encoding: str
    sha256: str


def parse_csv(data):
    encoding = "utf-8-sig" if data.startswith(b"\xef\xbb\xbf") else "utf-8"
    try:
        reader = csv.reader(io.StringIO(data.decode(encoding), newline=""), strict=True)
        columns = next(reader, [])
        if not columns or len(columns) > MAX_COLUMNS or len(columns) != len(set(columns)) or any(
            not column.strip() or len(column) > 128 or not column.isprintable() for column in columns
        ):
            raise TaskError("invalid_header", "CSV 需要 1–128 个非空且互不重复的列名，每个列名至多 128 个可打印字符。")
        rows = []
        for number, row in enumerate(reader, start=2):
            if len(row) != len(columns):
                raise TaskError("invalid_row", f"第 {number} 条 CSV 记录的字段数与表头不一致。")
            if len(rows) >= MAX_ROWS:
                raise TaskError("input_too_large", f"最多支持 {MAX_ROWS} 条数据记录。")
            rows.append(row)
    except (UnicodeError, csv.Error):
        raise TaskError("invalid_csv", "请使用结构有效的逗号分隔 CSV，编码为 UTF-8 或 UTF-8 BOM。") from None
    return Table(columns, rows, encoding, digest(data))


def encode_csv(table, rows):
    stream = io.StringIO(newline="")
    writer = csv.writer(stream)
    writer.writerow(table.columns)
    writer.writerows(rows)
    return stream.getvalue().encode(table.encoding)


def positions(table, rule):
    key_index = table.columns.index(rule["key"])
    order_index = None
    if rule["keep"] == "latest_timestamp":
        time_column = rule["time_column"]
        if time_column not in table.columns or time_column == rule["key"]:
            raise TaskError("invalid_rule", "请选择与去重键不同的现有时间列。")
        order_index = table.columns.index(time_column)
    keys, order = [], []
    time_zone_present = None
    for offset, row in enumerate(table.rows):
        key = row[key_index].strip().casefold()
        if not key:
            raise TaskError("empty_key", f"第 {offset + 2} 条 CSV 记录的去重键为空。")
        keys.append(key)
        if order_index is None:
            order.append(offset)
            continue
        raw_time = row[order_index].strip()
        try:
            if not TIMESTAMP.fullmatch(raw_time):
                raise ValueError
            parsed = datetime.fromisoformat(raw_time.removesuffix("Z") + "+00:00" if raw_time.endswith("Z") else raw_time)
            aware = parsed.tzinfo is not None
            normalized = parsed.astimezone(timezone.utc).replace(tzinfo=None) if aware else parsed
        except (ValueError, OverflowError):
            raise TaskError("invalid_timestamp", f"第 {offset + 2} 条 CSV 记录需要有效的 ISO 8601 日期时间。") from None
        if time_zone_present is not None and aware != time_zone_present:
            raise TaskError("mixed_timezones", "时间列需要统一使用带时区或不带时区的日期时间。")
        time_zone_present = aware
        order.append(normalized)
    return keys, order


def select_rows(table, keys, order):
    winners = {}
    conflicts = set()
    for index, key in enumerate(keys):
        previous = winners.get(key)
        if previous is None or order[index] > order[previous]:
            winners[key] = index
            conflicts.discard(key)
        elif order[index] == order[previous] and table.rows[index] != table.rows[previous]:
            conflicts.add(key)
    if conflicts:
        raise TaskError("timestamp_tie", "同一个键下有内容不同的并列最新记录，请先消除时间并列。")
    chosen = sorted(winners.values())
    return [table.rows[index] for index in chosen]


def verify_rows(table, keys, order, output):
    """Verify against a grouped reference calculation, independent of selection order."""
    groups = {}
    for index, key in enumerate(keys):
        groups.setdefault(key, []).append(index)
    expected = sorted(max(group, key=order.__getitem__) for group in groups.values())
    if output != [table.rows[index] for index in expected]:
        raise TaskError("verification_failed", "结果与已确认的保留策略不一致。")


def valid_rule(rule):
    if not isinstance(rule, dict) or set(rule) != {"key", "keep", "time_column"} or not isinstance(rule["key"], str) or not rule["key"]:
        return False
    if rule["keep"] == "last_row":
        return rule["time_column"] is None
    return rule["keep"] == "latest_timestamp" and isinstance(rule["time_column"], str) and rule["time_column"] not in ("", rule["key"])
