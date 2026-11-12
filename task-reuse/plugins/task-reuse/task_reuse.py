"""Local CSV workflows and verified deduplication."""

import argparse
import csv
import hashlib
import io
import json
import os
import re
import stat
import sys
import tempfile
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path, PureWindowsPath

from recipe_bindings import layout_id, resolve_rule


MAX_BYTES = 16 * 1024 * 1024
MAX_ROWS = 100_000
MAX_COLUMNS = 128
KEEP_MODES = ("last_row", "latest_timestamp")
RECIPE_ID = re.compile(r"[a-z][a-z0-9-]{0,47}\Z")
OBJECT_ID = re.compile(r"[0-9a-f]{64}\Z")
TIMESTAMP = re.compile(
    r"\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?"
    r"(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)?\Z"
)
INVALID_PATH_CHARS = re.compile(r'[<>:"|?*\x00-\x1f]')


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


def config_path():
    app_data = os.environ.get("LOCALAPPDATA")
    return (Path(app_data) if app_data else Path.home() / ".config") / "TaskReuse" / "workspace.json"


def workspace_from_config():
    override = os.environ.get("TASK_REUSE_WORKSPACE")
    if override:
        return Path(override)
    try:
        config = json.loads(config_path().read_text(encoding="utf-8"))
        return Path(config["workspace"])
    except (OSError, ValueError, TypeError, KeyError):
        raise TaskError("workspace_not_configured", "请先从本地命令行运行 --workspace <目录> configure，或设置 TASK_REUSE_WORKSPACE。") from None


def json_bytes(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")


def digest(data):
    return hashlib.sha256(data).hexdigest()


def publish(path, data, *, replace=False):
    """Stage on the same volume. Preserve unrelated existing output files."""
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as stream:
        staged = Path(stream.name)
        try:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
            stream.close()
            if replace:
                os.replace(staged, path)
            elif os.name == "nt":
                os.rename(staged, path)
            else:
                os.link(staged, path)
        finally:
            stream.close()
            staged.unlink(missing_ok=True)


def publish_or_compare(path, data, code):
    try:
        publish(path, data)
    except FileExistsError:
        with path.open("rb") as existing:
            if existing.read(len(data) + 1) != data:
                raise TaskError(code, "目标已存在且内容不同，未覆盖。") from None


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


def fixture(rule):
    """Keep the same independent oracle when a saved rule is rebound to a new header."""
    return {
        "rows": [["sample@example.invalid", "2026-11-03T11:00:00"], ["sample@example.invalid", "2026-11-03T10:00:00"]],
        "expected_record": 1 if rule["keep"] == "latest_timestamp" else 2,
    }


def verify_fixture(rule, example):
    columns = [rule["key"], rule.get("time_column") or "__time__"]
    if columns[0] == columns[1]:
        columns[1] = "__fixture_time__"
    fixture_rule = dict(rule)
    if rule["keep"] == "latest_timestamp":
        fixture_rule["time_column"] = columns[1]
    table = Table(columns, example["rows"], "utf-8", "")
    if select_rows(table, *positions(table, fixture_rule)) != [table.rows[example["expected_record"] - 1]]:
        raise TaskError("fixture_failed", "候选规则未通过已保存的对照样例。")


def input_record(path, table):
    return {"path": PureWindowsPath(path).as_posix(), "sha256": table.sha256}


def valid_rule(rule):
    if not isinstance(rule, dict) or set(rule) != {"key", "keep", "time_column"} or not isinstance(rule["key"], str) or not rule["key"]:
        return False
    if rule["keep"] == "last_row":
        return rule["time_column"] is None
    return rule["keep"] == "latest_timestamp" and isinstance(rule["time_column"], str) and rule["time_column"] not in ("", rule["key"])


class Runner:
    def __init__(self, workspace: Path):
        self.root = Path(workspace).resolve()
        if not self.root.is_dir():
            raise TaskError("invalid_workspace", "指定的本地工作区不存在或不是目录。")

    def path(self, relative):
        if not isinstance(relative, str) or not relative:
            raise TaskError("invalid_path", "请提供工作区内的相对路径。")
        candidate = PureWindowsPath(relative)
        if candidate.anchor or not candidate.parts or any(
            part == ".." or part.endswith((".", " ")) or INVALID_PATH_CHARS.search(part) or PureWindowsPath(part).is_reserved()
            for part in candidate.parts
        ):
            raise TaskError("invalid_path", "路径包含受限制的组件，请提供工作区内的相对路径。")
        resolved = self.root
        for part in candidate.parts:
            resolved = resolved / part
            try:
                metadata = resolved.lstat()
            except FileNotFoundError:
                continue
            if stat.S_ISLNK(metadata.st_mode) or getattr(metadata, "st_file_attributes", 0) & stat.FILE_ATTRIBUTE_REPARSE_POINT:
                raise TaskError("invalid_path", "路径包含链接或 Windows 重解析点。")
        return resolved

    def read_source(self, relative):
        path = self.path(relative)
        if path.suffix.lower() != ".csv" or not path.is_file():
            raise TaskError("invalid_input", "请选择工作区中现有的 CSV 文件。")
        with path.open("rb") as stream:
            data = stream.read(MAX_BYTES + 1)
        if len(data) > MAX_BYTES:
            raise TaskError("input_too_large", "CSV 超过 16 MiB 的首版限制。")
        return data

    def read_table(self, relative):
        return parse_csv(self.read_source(relative))

    def put_object(self, kind, record):
        data = json_bytes(record)
        identifier = digest(data)
        publish_or_compare(self.path(f".task-reuse/{kind}/{identifier}.json"), data, "state_conflict")
        return identifier

    def get_object(self, kind, identifier):
        if not isinstance(identifier, str) or not OBJECT_ID.fullmatch(identifier):
            raise TaskError("invalid_id", "无效的本地文件或预览引用。")
        path = self.path(f".task-reuse/{kind}/{identifier}.json")
        try:
            data = path.read_bytes()
        except FileNotFoundError:
            raise TaskError("unknown_id", "找不到引用，请重新检查或预览。") from None
        if digest(data) != identifier:
            raise TaskError("state_conflict", "本地状态与引用不一致，请重新预览。")
        return json.loads(data)

    def inspect(self, path):
        table = self.read_table(path)
        identifier = self.put_object("inputs", input_record(path, table))
        return {"status": "inspected", "input_id": identifier, "columns": table.columns, "row_count": len(table.rows), "encoding": table.encoding}

    def current_table(self, record):
        try:
            table = self.read_table(record["path"])
        except TaskError as error:
            if error.code == "invalid_path":
                raise
            raise TaskError("input_changed", "输入已变化，请重新检查和预览。") from None
        if table.sha256 != record["sha256"]:
            raise TaskError("input_changed", "输入已变化，请重新检查和预览。")
        return table

    def recipe_path(self, name):
        if not isinstance(name, str) or not RECIPE_ID.fullmatch(name) or PureWindowsPath(name).is_reserved():
            raise TaskError("invalid_recipe_id", "规则名应以小写字母开头，最多 48 个小写字母、数字或连字符。")
        return self.path(f".task-reuse/recipes/{name}.json")

    def read_recipe(self, name, optional=False):
        try:
            record = json.loads(self.recipe_path(name).read_bytes())
        except FileNotFoundError:
            if optional:
                return None
            raise TaskError("unknown_recipe", "找不到已保存的规则。") from None
        except ValueError:
            raise TaskError("invalid_recipe", "规则文件不是有效的 JSON。") from None
        if not isinstance(record, dict) or record.get("schema_version") != 1 or record.get("recipe_id") != name:
            raise TaskError("invalid_recipe", "规则格式或版本不受支持。")
        rule = record.get("rule")
        if not valid_rule(rule):
            raise TaskError("invalid_recipe", "规则缺少有效的去重键或保留策略。")
        layouts = record.get("layouts", {})
        if not isinstance(layouts, dict) or any(
            not OBJECT_ID.fullmatch(layout) or not valid_rule(binding) or binding["keep"] != rule["keep"]
            for layout, binding in layouts.items()
        ):
            raise TaskError("invalid_recipe", "规则中保存的表头映射无效。")
        if record.get("fixture") != fixture(rule) or type(record.get("revision")) is not int or record["revision"] < 1:
            raise TaskError("invalid_recipe", "规则缺少有效的版本或回归样例。")
        return record

    def draft(self, input_path, goal):
        if not goal.strip() or len(goal) > 1000:
            raise TaskError("invalid_goal", "请输入不超过 1000 个字符的任务描述。")
        fields = self.read_table(input_path).columns
        prompt = (
            "请为本地 CSV 去重提出候选规则。字段名称和任务描述仅用于选参数。"
            "仅返回 JSON 对象，包含 key、keep、time_column 三个字段。"
            "key 必须是给定列名。keep 可为 last_row（按文件顺序保留最后一条）、"
            "latest_timestamp（按时间保留最新一条）或 null（含义不明确）。"
            "仅 latest_timestamp 需要另一个有效列名作为 time_column，其余情况填 null。\n"
            f"列名：{json.dumps(fields, ensure_ascii=False)}\n"
            f"任务描述：{json.dumps(goal, ensure_ascii=False)}"
        )
        return {"status": "drafted", "prompt": prompt}

    def read_candidate(self, relative):
        path = self.path(relative)
        if path.suffix.lower() != ".json" or not path.is_file():
            raise TaskError("invalid_candidate", "请选择工作区中现有的候选规则 JSON 文件。")
        with path.open("rb") as stream:
            data = stream.read(8193)
        try:
            if len(data) > 8192:
                raise ValueError
            candidate = json.loads(data.decode("utf-8-sig"))
        except (ValueError, RecursionError):
            raise TaskError("invalid_candidate", "候选规则需要是 8 KiB 以内的有效 UTF-8 JSON。") from None
        if not isinstance(candidate, dict) or set(candidate) != {"key", "keep", "time_column"} or not isinstance(candidate["key"], str) or any(
            value is not None and not isinstance(value, str) for value in (candidate["keep"], candidate["time_column"])
        ):
            raise TaskError("invalid_candidate", "候选规则只接受 key、keep、time_column 三个参数。")
        return candidate

    def bind_recipe(self, table, recipe_id, replacement=None):
        saved = self.read_recipe(recipe_id)
        rule, missing, alternatives = resolve_rule(saved, table.columns)
        unresolved = [*missing, *alternatives]
        if unresolved and replacement is None:
            return {
                "status": "needs_binding", "missing_columns": [rule[field] for field in missing],
                "alternatives": alternatives, "columns": table.columns, "recipe_id": recipe_id,
            }
        if replacement is not None:
            if len(unresolved) != 1 or replacement not in alternatives.get(unresolved[0], table.columns):
                raise TaskError("invalid_binding", "一次只能确认一个待定字段，并使用可选的现有列。")
            rule[unresolved[0]] = replacement
        if not valid_rule(rule):
            raise TaskError("invalid_binding", "时间列和去重键必须对应不同的列。")
        return {"rule": rule, "fixture": saved["fixture"], "recipe_id": recipe_id, "base_revision": saved["revision"]}

    def preview(self, input_id, key=None, keep=None, time_column=None, recipe_id=None, replacement=None):
        record = self.get_object("inputs", input_id)
        table = self.current_table(record)
        plan = self.prepare(table, key, keep, time_column, recipe_id, replacement)
        if "status" in plan:
            return plan
        plan["input_id"] = input_id
        rule = plan["rule"]
        verify_fixture(rule, plan["fixture"])
        keys, order = positions(table, rule)
        rows = select_rows(table, keys, order)
        verify_rows(table, keys, order, rows)
        return {"status": "ready", "plan_id": self.put_object("plans", plan), "rule": rule, "input_rows": len(table.rows), "output_rows": len(rows)}

    def prepare(self, table, key, keep, time_column, recipe_id, replacement):
        if recipe_id is not None:
            if any(value is not None for value in (key, keep, time_column)):
                raise TaskError("invalid_rule", "复用已有规则时，请通过 replacement 处理待定字段。")
            return self.bind_recipe(table, recipe_id, replacement)
        if replacement is not None:
            raise TaskError("invalid_binding", "指定 replacement 前需要选择已有规则。")
        if key is None:
            return {"status": "needs_key", "columns": table.columns}
        if key not in table.columns:
            raise TaskError("invalid_rule", "请指定实际存在的去重键列。")
        if keep is None:
            return {
                "status": "needs_choice", "columns": table.columns,
                "choices": [
                    {"keep": "last_row", "label": "按文件顺序保留最后一条", "keeps_record": 2},
                    {"keep": "latest_timestamp", "label": "按时间保留最新一条", "keeps_record": 1},
                ],
                "example_columns": ["示例键", "示例时间"], "example": fixture({"keep": "last_row"})["rows"],
            }
        if keep == "latest_timestamp" and time_column is None:
            return {"status": "needs_time_column", "columns": [column for column in table.columns if column != key]}
        rule = {"key": key, "keep": keep, "time_column": time_column}
        if not valid_rule(rule) or (time_column is not None and time_column not in table.columns):
            raise TaskError("invalid_rule", "请选择受支持的保留策略和对应列。")
        return {"rule": rule, "fixture": fixture(rule), "recipe_id": None, "base_revision": None}

    @contextmanager
    def run_lock(self):
        lock = self.path(".task-reuse/run.lock")
        lock.parent.mkdir(exist_ok=True)
        with lock.open("ab") as stream:
            if os.name == "nt":
                import msvcrt
                stream.seek(0)
                msvcrt.locking(stream.fileno(), msvcrt.LK_LOCK, 1)
            else:
                import fcntl
                fcntl.flock(stream, fcntl.LOCK_EX)
            # Closing the handle releases the lock, including after an exception.
            yield

    def run(self, plan_id=None, recipe_id=None, input_path=None, save_as=None):
        if plan_id is None:
            if recipe_id is None or input_path is None or save_as is not None:
                raise TaskError("invalid_run", "请指定预览，或同时指定已有规则和输入文件。")
            return self.process(input_path, recipe_id=recipe_id)
        if recipe_id is not None or input_path is not None:
            raise TaskError("invalid_run", "提交预览时只需提供 plan_id 与可选的 save_as。")
        plan = self.get_object("plans", plan_id)
        record = self.get_object("inputs", plan["input_id"])
        with self.run_lock():
            return self.commit(plan_id, plan, record, self.current_table(record), save_as)

    def process(self, path, key=None, keep=None, time_column=None, recipe_id=None, replacement=None, save_as=None):
        with self.run_lock():
            table = self.read_table(path)
            plan = self.prepare(table, key, keep, time_column, recipe_id, replacement)
            if "status" in plan:
                return plan
            record = input_record(path, table)
            # Match preview/apply identity without a second parse or a persisted preview.
            plan["input_id"] = digest(json_bytes(record))
            return self.commit(digest(json_bytes(plan)), plan, record, table, save_as)

    def commit(self, plan_id, plan, record, table, save_as):
        rule = plan["rule"]
        verify_fixture(rule, plan["fixture"])
        keys, order = positions(table, rule)
        output = select_rows(table, keys, order)
        data = encode_csv(table, output)
        decoded = parse_csv(data)
        if decoded.columns != table.columns:
            raise TaskError("verification_failed", "结果的表头发生了意外变化。")
        verify_rows(table, keys, order, decoded.rows)

        old = self.read_recipe(save_as, optional=True) if save_as is not None else None
        revision = plan["base_revision"]
        saved = None
        if save_as is not None:
            layout = layout_id(table.columns)
            layouts = {} if old is None else dict(old.get("layouts", {}))
            if old is None:
                revision = 1
            elif layouts.get(layout) == rule:
                revision, saved = old["revision"], old
            elif old["rule"] == rule or (plan["recipe_id"] == save_as and old["revision"] == plan["base_revision"]):
                revision = old["revision"] + 1
            else:
                raise TaskError("recipe_conflict", "同名规则已存在或版本已变化，请重新预览或选用新名称。")
            if saved is None:
                layouts[layout] = rule
                saved = {
                    "schema_version": 1, "recipe_id": save_as, "revision": revision,
                    "rule": old["rule"] if old is not None else rule, "fixture": plan["fixture"], "layouts": layouts,
                }

        if digest(self.read_source(record["path"])) != record["sha256"]:
            raise TaskError("input_changed", "输入在执行期间发生变化，请重新预览。")
        path = self.path(f"task-reuse-output/{plan_id}.csv")
        publish_or_compare(path, data, "output_exists")
        if saved is not None and saved != old:
            publish(self.recipe_path(save_as), json_bytes(saved), replace=old is not None)
        return {
            "status": "completed", "output_path": str(path), "input_rows": len(table.rows),
            "output_rows": len(output), "duplicates_removed": len(table.rows) - len(output),
            "checks": ["fixture_passed", "unique_keys", "correct_winners", "original_row_values", "input_unchanged"],
            "recipe_id": save_as or plan["recipe_id"], "recipe_revision": revision,
            "model_calls": 0,
        }


def workflow_command(runner, args):
    from csv_pipeline import apply_pipeline, execute_pipeline, list_workflows, replay_pipeline

    if args.action == "list":
        return {"status": "listed", "workflows": list_workflows(runner)}
    if args.action == "run":
        return replay_pipeline(runner, args.input, args.workflow, preview=args.preview)
    if args.action == "apply":
        return apply_pipeline(runner, args.plan_id, save_as=args.save_as)
    path = runner.path(args.steps_file)
    if path.suffix.lower() != ".json" or not path.is_file():
        raise TaskError("invalid_steps_file", "请选择工作区内已有的 JSON 步骤文件。")
    with path.open("rb") as stream:
        limit = 32 * 1024
        data = stream.read(limit + 1)
    try:
        if len(data) > limit:
            raise ValueError
        steps = json.loads(data.decode("utf-8-sig"))
    except (ValueError, RecursionError):
        raise TaskError("invalid_steps_file", "步骤文件需要是 32 KiB 以内的有效 UTF-8 JSON。") from None
    return execute_pipeline(runner, args.input, steps, preview=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--workspace", type=Path, help="本地工作区路径。")
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("configure")
    dsh_patch = commands.add_parser("dsh-patch", help="生成 DeepSeek Harness 的本地 MCP 配置。")
    dsh_patch.add_argument("--output", type=Path, help="可选输出文件，默认写入 stdout。")
    dsh_patch.add_argument("--workflows", action="store_true", help="启用组合流程与重复文本分类工具。")
    inspect = commands.add_parser("inspect")
    inspect.add_argument("input")
    preview = commands.add_parser("preview")
    preview.add_argument("input")
    preview.add_argument("--key")
    preview.add_argument("--keep", choices=KEEP_MODES)
    preview.add_argument("--time-column")
    preview.add_argument("--recipe")
    preview.add_argument("--replacement")
    preview.add_argument("--candidate")
    draft = commands.add_parser("draft", help="生成仅含列名和目标的候选规则提示。")
    draft.add_argument("input")
    draft.add_argument("--goal", required=True)
    apply = commands.add_parser("apply")
    apply.add_argument("plan_id")
    apply.add_argument("--save-as")
    run = commands.add_parser("run")
    run.add_argument("recipe_id")
    run.add_argument("--input", required=True)
    workflow = commands.add_parser("workflow", help="在本机预览、确认和复用组合流程。")
    actions = workflow.add_subparsers(dest="action", required=True)
    actions.add_parser("list", help="列出已保存的组合流程。")
    workflow_plan = actions.add_parser("plan", help="从 JSON 步骤文件预览一次执行。")
    workflow_plan.add_argument("input")
    workflow_plan.add_argument("--steps-file", required=True)
    workflow_apply = actions.add_parser("apply", help="按 plan_id 确认执行预览。")
    workflow_apply.add_argument("plan_id")
    workflow_apply.add_argument("--save-as")
    workflow_run = actions.add_parser("run", help="对新 CSV 运行已保存的流程。")
    workflow_run.add_argument("workflow")
    workflow_run.add_argument("--input", required=True)
    workflow_run.add_argument("--preview", action="store_true")
    args = parser.parse_args()
    try:
        if args.command in ("configure", "dsh-patch") and args.workspace is None:
            raise TaskError("invalid_workspace", f"{args.command} 需要显式指定 --workspace <目录>。")
        runner = Runner(args.workspace or workspace_from_config())
        if args.command == "configure":
            publish(config_path(), json_bytes({"workspace": str(runner.root)}), replace=True)
            result = {"status": "configured", "workspace": str(runner.root)}
        elif args.command == "dsh-patch":
            from dsh_config import profile_patch

            patch = json.dumps(profile_patch(runner.root, args.workflows), ensure_ascii=False, indent=2)
            if args.output is None:
                print(patch)
                return 0
            destination = args.output.resolve()
            publish_or_compare(destination, (patch + "\n").encode("utf-8"), "output_exists")
            result = {"status": "configured", "patch_path": str(destination)}
        elif args.command == "inspect":
            result = runner.inspect(args.input)
        elif args.command == "preview":
            identifier = runner.inspect(args.input)["input_id"]
            if args.candidate is not None:
                if any(value is not None for value in (args.key, args.keep, args.time_column, args.recipe, args.replacement)):
                    raise TaskError("invalid_candidate", "导入候选规则时只需指定 CSV 与 --candidate。")
                result = runner.preview(identifier, **runner.read_candidate(args.candidate))
            else:
                result = runner.preview(identifier, args.key, args.keep, args.time_column, args.recipe, args.replacement)
        elif args.command == "draft":
            result = runner.draft(args.input, args.goal)
        elif args.command == "apply":
            result = runner.run(plan_id=args.plan_id, save_as=args.save_as)
        elif args.command == "workflow":
            result = workflow_command(runner, args)
        else:
            result = runner.run(recipe_id=args.recipe_id, input_path=args.input)
        print(json.dumps(result, ensure_ascii=False))
        return 2 if result["status"].startswith("needs_") else 0
    except TaskError as error:
        print(json.dumps(error_receipt(error), ensure_ascii=False))
    except OSError:
        print(json.dumps({"status": "error", "code": "io_error", "message": "本地文件读取或写入失败，请检查文件占用和工作区权限。"}, ensure_ascii=False))
    return 1


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
    sys.exit(main())
