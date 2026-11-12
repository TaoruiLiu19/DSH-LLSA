"""Run and verify ordered, local CSV operations without model calls."""

import json
from collections import Counter
from itertools import compress, groupby
from operator import itemgetter
from pathlib import PureWindowsPath

from task_reuse import (
    MAX_BYTES,
    OBJECT_ID,
    RECIPE_ID,
    Table,
    TaskError,
    digest,
    encode_csv,
    input_record,
    json_bytes,
    parse_csv,
    positions,
    publish,
    publish_or_compare,
    select_rows,
    valid_rule,
    verify_rows,
)


MAX_STEPS = 8
MAX_PLAN_BYTES = 64 * 1024
MAX_WORKFLOW_BYTES = MAX_PLAN_BYTES + 256
PIPELINE_FORMAT = "csv_pipeline_v1"
WORKFLOW_DIRECTORY = ".task-reuse/workflows"
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


def workflow_path(runner, name, *, create_parent=False):
    if not isinstance(name, str) or not RECIPE_ID.fullmatch(name) or PureWindowsPath(name).is_reserved():
        raise TaskError("invalid_workflow", "流程名应以小写字母开头，最多 48 个小写字母、数字或连字符。")
    try:
        if create_parent:
            runner.path(WORKFLOW_DIRECTORY).mkdir(exist_ok=True)
        return runner.path(f"{WORKFLOW_DIRECTORY}/{name}.json")
    except OSError:
        raise TaskError("workflow_unavailable", "无法访问本地 CSV 流程目录。") from None


def read_workflow(runner, name, *, optional=False):
    path = workflow_path(runner, name)
    try:
        with path.open("rb") as stream:
            data = stream.read(MAX_WORKFLOW_BYTES + 1)
    except FileNotFoundError:
        if optional:
            return None
        raise TaskError("unknown_workflow", "找不到已保存的 CSV 流程。") from None
    except OSError:
        raise TaskError("workflow_unavailable", "无法读取本地 CSV 流程。") from None
    try:
        if len(data) > MAX_WORKFLOW_BYTES:
            raise ValueError
        record = json.loads(data)
        if not isinstance(record, dict) or set(record) != {"format", "steps"} or record["format"] != PIPELINE_FORMAT:
            raise ValueError
        return normalize_steps(record["steps"])
    except (ValueError, RecursionError, TaskError):
        raise TaskError("invalid_workflow", "已保存的 CSV 流程格式无效。") from None


def list_workflows(runner):
    directory = runner.path(WORKFLOW_DIRECTORY)
    return [
        {"name": path.stem, "operations": [step["op"] for step in read_workflow(runner, path.stem)]}
        for path in sorted(directory.glob("*.json"))
        if RECIPE_ID.fullmatch(path.stem) and not PureWindowsPath(path.stem).is_reserved()
    ]


def execute_pipeline(runner, path, steps, preview=False, *, save_as=None):
    if not isinstance(preview, bool):
        raise TaskError("invalid_preview", "preview 必须为布尔值。")
    if preview and save_as is not None:
        raise TaskError("invalid_preview", "仅预览时请省略 save_as。")
    steps = normalize_steps(steps)
    source = runner.read_table(path)
    plan = {"format": PIPELINE_FORMAT, "input": input_record(path, source), "steps": steps}
    return execute_plan(runner, source, plan, preview, save_as)


def apply_pipeline(runner, plan_id, save_as=None):
    try:
        plan = runner.get_object("pipeline-plans", plan_id)
    except (ValueError, RecursionError):
        raise TaskError("invalid_plan", "预览格式无效，请重新预览。") from None
    if not isinstance(plan, dict) or set(plan) != {"format", "input", "steps"} or plan["format"] != PIPELINE_FORMAT:
        raise TaskError("invalid_plan", "预览格式无效，请重新预览。")
    record = plan["input"]
    if not isinstance(record, dict) or set(record) != {"path", "sha256"} or not isinstance(record["path"], str) or (
        not isinstance(record["sha256"], str) or not OBJECT_ID.fullmatch(record["sha256"])
    ):
        raise TaskError("invalid_plan", "预览缺少有效的原始文件记录。")
    try:
        if normalize_steps(plan["steps"]) != plan["steps"] or digest(json_bytes(plan)) != plan_id:
            raise ValueError
    except (ValueError, TaskError):
        raise TaskError("invalid_plan", "预览中的流程步骤无效，请重新预览。") from None
    source = runner.current_table(record)
    return execute_plan(runner, source, plan, False, save_as)


def replay_pipeline(runner, path, workflow, preview=False):
    result = execute_pipeline(runner, path, read_workflow(runner, workflow), preview=preview)
    result["workflow"] = workflow
    return result


def publish_with_workflow(output, data, workflow, steps):
    created_output = False
    try:
        publish(output, data)
        created_output = True
    except FileExistsError:
        publish_or_compare(output, data, "output_exists")

    try:
        publish_or_compare(workflow, json_bytes({"format": PIPELINE_FORMAT, "steps": steps}), "workflow_conflict")
    except (OSError, TaskError) as error:
        if created_output:
            output.unlink(missing_ok=True)
        if isinstance(error, OSError):
            raise TaskError("workflow_unavailable", "无法保存本地 CSV 流程。") from None
        raise


def execute_plan(runner, source, plan, preview, save_as):
    table = source
    receipts = []
    for index, step in enumerate(plan["steps"], 1):
        operation = step["op"]
        arguments = {name: value for name, value in step.items() if name != "op"}
        input_rows = len(table.rows)
        try:
            table = OPERATIONS[operation](table, **arguments)
        except TaskError as error:
            raise PipelineError(index, error) from None
        receipts.append({"op": operation, "input_rows": input_rows, "output_rows": len(table.rows)})

    data = encode_csv(table, table.rows)
    if len(data) > MAX_BYTES:
        raise TaskError("output_too_large", "结果 CSV 超过本地执行器的 16 MiB 限制。")
    decoded = parse_csv(data)
    if decoded.columns != table.columns or decoded.rows != table.rows:
        raise TaskError("verification_failed", "序列化后的 CSV 与已验证的结果不一致。")

    result = {
        "status": "ready" if preview else "completed",
        "input_rows": len(source.rows),
        "output_rows": len(table.rows),
        "steps": receipts,
        "checks": ["steps_verified", "csv_round_trip"],
        "model_calls": 0,
    }
    if preview:
        result["plan_id"] = runner.put_object("pipeline-plans", plan)
        return result

    identity = digest(json_bytes(plan))
    output_ref = f"task-reuse-output/{identity}.csv"
    with runner.run_lock():
        workflow = workflow_path(runner, save_as, create_parent=True) if save_as is not None else None
        existing = read_workflow(runner, save_as, optional=True) if workflow is not None else None
        if existing is not None and existing != plan["steps"]:
            raise TaskError("workflow_conflict", "同名 CSV 流程已有不同步骤，请使用新名称。")
        try:
            current = runner.read_source(plan["input"]["path"])
        except TaskError as error:
            if error.code not in {"invalid_input", "input_too_large"}:
                raise
            raise TaskError("input_changed", "输入在执行期间发生变化，请重新执行。") from None
        if digest(current) != source.sha256:
            raise TaskError("input_changed", "输入在执行期间发生变化，请重新执行。")
        output = runner.path(output_ref)
        if workflow is not None and existing is None:
            publish_with_workflow(output, data, workflow, plan["steps"])
        else:
            publish_or_compare(output, data, "output_exists")
        if workflow is not None:
            result["workflow"] = save_as
    result["output_path"] = str(output)
    result["output_ref"] = output_ref
    result["checks"].append("input_unchanged")
    return result
