"""Collect one classification per exact text value, then verify and expand it locally."""

from collections import Counter

from task_reuse import (
    MAX_BYTES, MAX_COLUMNS, Table, TaskError, digest, encode_csv, input_record, json_bytes, parse_csv, publish_or_compare,
)


LABEL_COLUMN = "review_label"
MAX_CANDIDATES = 64
MAX_PAYLOAD_BYTES = 16 * 1024


def checked_labels(labels):
    if not isinstance(labels, list) or not 1 <= len(labels) <= 16 or any(
        not isinstance(label, str) or not label.strip() or len(label) > 80 or not label.isprintable()
        for label in labels
    ) or len(set(labels)) != len(labels):
        raise TaskError("invalid_labels", "请指定 1–16 个不重复的标签，每个最多 80 个可打印字符。")
    return labels


def group_values(table, column):
    if column not in table.columns:
        raise TaskError("invalid_column", "请选择 CSV 中存在的待分类列。")
    if LABEL_COLUMN in table.columns:
        raise TaskError("invalid_column", f"输入已有 {LABEL_COLUMN} 列，请先选择未添加分类的原件。")
    if len(table.columns) >= MAX_COLUMNS:
        raise TaskError("invalid_column", "输入已达到 CSV 列数上限，无法添加分类列。")
    index = table.columns.index(column)
    return index, Counter(row[index] for row in table.rows)


def prepare_review(runner, path, column, labels):
    labels = checked_labels(labels)
    table = runner.read_table(path)
    _, counts = group_values(table, column)
    receipt = {"input_rows": len(table.rows), "distinct_values": len(counts), "model_calls": 0}
    if len(counts) > MAX_CANDIDATES:
        return {**receipt, "status": "not_applicable", "reason": "too_many_distinct_values"}
    candidates = [
        {"id": identifier, "text": text, "rows": count}
        for identifier, (text, count) in enumerate(counts.items(), start=1)
    ]
    baseline_bytes = 2 + max(len(table.rows) - 1, 0) + sum(
        len(json_bytes(text)) * count for text, count in counts.items()
    )
    # Include the whole model-facing receipt and bound the assignment call.
    # Eight placeholder digits cover the estimate itself for any allowed CSV.
    pending = {
        **receipt, "status": "needs_labels", "review_id": "0" * 64,
        "labels": labels, "candidates": candidates, "ungrouped_values_bytes": baseline_bytes,
        "grouped_review_estimate_bytes": 99_999_999,
    }
    longest_label = max(labels, key=lambda label: len(json_bytes(label)))
    response_bound = [{"id": item["id"], "label": longest_label} for item in candidates]
    payload_bytes = len(json_bytes(pending))
    projected_bytes = payload_bytes + len(json_bytes({"review_id": pending["review_id"], "assignments": response_bound}))
    estimate = {"ungrouped_values_bytes": baseline_bytes, "grouped_review_estimate_bytes": projected_bytes}
    if payload_bytes > MAX_PAYLOAD_BYTES or projected_bytes * 5 > baseline_bytes * 4:
        return {**receipt, **estimate, "status": "not_applicable", "reason": "insufficient_byte_savings"}

    pending["review_id"] = runner.put_object("reviews", {"source": input_record(path, table), "column": column, "labels": labels})
    pending["grouped_review_estimate_bytes"] = projected_bytes
    return pending


def assignment_map(assignments, labels, expected):
    if not isinstance(assignments, list) or len(assignments) != expected:
        raise TaskError("invalid_assignments", "每个候选 ID 都需要恰好一个标签。")
    by_id = {}
    for assignment in assignments:
        if not isinstance(assignment, dict) or set(assignment) != {"id", "label"}:
            raise TaskError("invalid_assignments", "分类结果只接受 id 与 label。")
        identifier, label = assignment["id"], assignment["label"]
        if type(identifier) is not int or not 1 <= identifier <= expected or identifier in by_id or label not in labels:
            raise TaskError("invalid_assignments", "存在未知、重复的候选 ID，或标签不在允许列表中。")
        by_id[identifier] = label
    return by_id


def apply_review(runner, review_id, assignments):
    with runner.run_lock():
        review = runner.get_object("reviews", review_id)
        record = review["source"]
        table = runner.current_table(record)
        index, counts = group_values(table, review["column"])
        by_id = assignment_map(assignments, review["labels"], len(counts))
        by_value = {text: by_id[identifier] for identifier, text in enumerate(counts, start=1)}
        columns = [*table.columns, LABEL_COLUMN]
        output = [[*row, by_value[row[index]]] for row in table.rows]
        data = encode_csv(Table(columns, [], table.encoding, ""), output)
        if len(data) > MAX_BYTES:
            raise TaskError("output_too_large", "添加分类后的 CSV 超过 16 MiB 输出限制。")
        decoded = parse_csv(data)
        if decoded.columns != columns or len(decoded.rows) != len(table.rows) or any(
            row[:-1] != original or row[-1] != by_value[original[index]]
            for original, row in zip(table.rows, decoded.rows)
        ):
            raise TaskError("verification_failed", "分类结果未通过覆盖率或原字段一致性检查。")
        if digest(runner.read_source(record["path"])) != record["sha256"]:
            raise TaskError("input_changed", "输入在执行期间发生变化，请重新准备分类。")
        output_id = digest(json_bytes({"review": review_id, "labels": by_id}))
        output_ref = f"task-reuse-output/review-{output_id}.csv"
        path = runner.path(output_ref)
        publish_or_compare(path, data, "output_exists")
        return {
            "status": "completed", "output_path": str(path), "output_ref": output_ref, "input_rows": len(table.rows),
            "output_rows": len(decoded.rows), "classified_values": len(counts),
            "checks": ["complete_label_coverage", "allowed_labels", "original_row_values", "input_unchanged"],
            "model_calls": 0,
        }
