"""Run and verify ordered, local CSV operations without model calls."""

import json
from collections import Counter
from itertools import compress, groupby
from operator import itemgetter
from csv_core import (
    MAX_BYTES, Table, TaskError, encode_csv, parse_csv,
    positions, select_rows, valid_rule, verify_rows,
)


def json_bytes(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")


MAX_STEPS = 8
MAX_PLAN_BYTES = 64 * 1024
REQUIRED = {
    "filter_eq": {"op", "column", "value"},
    "dedupe": {"op", "key", "keep"},
    "group_count": {"op", "column"},
}


class PipelineError(TaskError):
    def __init__(self, step, error):
        super().__init__(error.code, error.message)
        self.step = step
        if hasattr(error, "column"):
            self.column = error.column
            self.columns = error.columns


class MissingColumn(TaskError):
    def __init__(self, column, columns):
        super().__init__("unknown_column", "该步骤引用了不存在的列。")
        self.column = column
        self.columns = []
        remaining_bytes = 2048
        for candidate in columns[:40]:
            remaining_bytes -= len(json_bytes(candidate)) + 1
            if remaining_bytes < 0:
                break
            self.columns.append(candidate)


def valid_column_name(value):
    return isinstance(value, str) and 1 <= len(value) <= 128 and value.isprintable() and bool(value.strip())


def normalize_step(step, is_last):
    operation = step.get("op") if isinstance(step, dict) else None
    if not isinstance(operation, str) or operation not in REQUIRED:
        raise TaskError("invalid_step", "请选择 filter_eq、dedupe 或 group_count 操作。")
    required = REQUIRED[operation]
    allowed = required | {"time_column"} if operation == "dedupe" else required
    if not required <= step.keys() <= allowed:
        raise TaskError("invalid_step", "该步骤的参数缺失或包含不受支持的参数。")

    if operation == "dedupe":
        rule = {"key": step["key"], "keep": step["keep"], "time_column": step.get("time_column")}
        if not valid_rule(rule) or not valid_column_name(rule["key"]) or (
            rule["time_column"] is not None and not valid_column_name(rule["time_column"])
        ):
            raise TaskError("invalid_rule", "请选择受支持的保留策略和对应列。")
        return {"op": operation, **rule}

    if not valid_column_name(step["column"]):
        raise TaskError("invalid_step", "请指定有效的列名。")
    if operation == "filter_eq" and not isinstance(step["value"], str):
        raise TaskError("invalid_step", "筛选值必须是字符串。")
    if operation == "group_count" and not is_last:
        raise TaskError("invalid_step", "分组计数须作为最后一步。")
    return dict(step)


def check_column(table, column):
    if column not in table.columns:
        raise MissingColumn(column, table.columns)
    return table.columns.index(column)


def filter_rows(table, column, value):
    index = check_column(table, column)
    select = map(lambda cell: cell == value, map(itemgetter(index), table.rows))
    filtered = list(compress(table.rows, select))
    if filtered != [row for row in table.rows if row[index] == value]:
        raise TaskError("verification_failed", "筛选后的行与等值条件不一致。")
    return Table(table.columns, filtered, table.encoding, table.sha256)


def dedupe_rows(table, key, keep, time_column):
    check_column(table, key)
    if keep == "latest_timestamp":
        check_column(table, time_column)
    rule = {"key": key, "keep": keep, "time_column": time_column}
    keys, order = positions(table, rule)
    rows = select_rows(table, keys, order)
    verify_rows(table, keys, order, rows)
    return Table(table.columns, rows, table.encoding, table.sha256)


def count_groups(table, column):
    if column == "count":
        raise TaskError("invalid_step", "分组列名与结果列 count 冲突。")
    index = check_column(table, column)
    labels = [row[index] for row in table.rows]
    counts = Counter(labels)
    rows = [[label, str(counts[label])] for label in sorted(counts)]
    expected = [[label, str(sum(1 for _ in group))] for label, group in groupby(sorted(labels))]
    if rows != expected:
        raise TaskError("verification_failed", "分组计数与输入行不一致。")
    return Table([column, "count"], rows, table.encoding, table.sha256)


OPERATIONS = {"filter_eq": filter_rows, "dedupe": dedupe_rows, "group_count": count_groups}


def normalize_steps(steps):
    if not isinstance(steps, list) or not 1 <= len(steps) <= MAX_STEPS:
        raise TaskError("invalid_steps", f"请提供 1–{MAX_STEPS} 个有序步骤。")
    plan = []
    for index, step in enumerate(steps, 1):
        try:
            normalized = normalize_step(step, is_last=index == len(steps))
            # Reject strings that cannot be represented by the UTF-8 plan format.
            json_bytes(normalized)
        except UnicodeError:
            raise PipelineError(index, TaskError("invalid_step", "步骤参数必须是有效的 Unicode 文本。")) from None
        except TaskError as error:
            raise PipelineError(index, error) from None
        plan.append(normalized)
    if len(json_bytes(plan)) > MAX_PLAN_BYTES:
        raise TaskError("invalid_steps", "流程步骤超出 64 KiB 的配置限制。")
    return plan


def execute_pipeline(raw, steps):
    if len(raw) > MAX_BYTES:
        raise TaskError("input_too_large", "CSV 超过 16 MiB。")
    table = parse_csv(raw)
    input_rows = len(table.rows)
    receipts = []
    for index, step in enumerate(normalize_steps(steps), 1):
        operation = step["op"]
        args = {key: value for key, value in step.items() if key != "op"}
        seen = len(table.rows)
        try:
            table = OPERATIONS[operation](table, **args)
        except TaskError as error:
            raise PipelineError(index, error) from None
        receipts.append({"op": operation, "input_rows": seen, "output_rows": len(table.rows)})

    data = encode_csv(table, table.rows)
    if len(data) > MAX_BYTES:
        raise TaskError("output_too_large", "结果 CSV 超过 16 MiB。")
    decoded = parse_csv(data)
    if decoded.columns != table.columns or decoded.rows != table.rows:
        raise TaskError("verification_failed", "序列化后的 CSV 与已验证的结果不一致。")
    return data, {"status": "completed", "input_rows": input_rows, "output_rows": len(table.rows),
                  "steps": receipts, "checks": ["steps_verified", "csv_round_trip"], "model_calls": 0}
