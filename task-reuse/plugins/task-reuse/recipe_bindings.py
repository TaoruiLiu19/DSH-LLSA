"""Resolve previously confirmed CSV column layouts for a saved rule."""

import hashlib
import json


def layout_id(columns):
    return hashlib.sha256(json.dumps(sorted(columns), ensure_ascii=False).encode("utf-8")).hexdigest()


def rule_fields(rule):
    return ("key", "time_column") if rule["keep"] == "latest_timestamp" else ("key",)


def known_rules(recipe):
    return [recipe["rule"], *recipe.get("layouts", {}).values()]


def resolve_rule(recipe, columns):
    """Return a candidate, missing fields, and alternatives for ambiguous bindings."""
    current = recipe["rule"]
    pinned = recipe.get("layouts", {}).get(layout_id(columns))
    if pinned is not None and all(pinned[field] in columns for field in rule_fields(pinned)):
        return dict(pinned), [], {}

    fields = rule_fields(current)
    matches = {}
    for rule in known_rules(recipe):
        if all(rule[field] in columns for field in fields):
            matches[tuple(rule[field] for field in fields)] = rule
    if not matches:
        missing = [field for field in fields if current[field] not in columns]
        return dict(current), missing, {}
    candidate = dict(next(iter(matches.values())))
    alternatives = {}
    for index, field in enumerate(fields):
        choices = sorted({match[index] for match in matches})
        if len(choices) > 1:
            alternatives[field] = choices
    return candidate, [], alternatives
