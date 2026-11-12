import csv
import json
import os
from pathlib import Path
from queue import Empty, Queue
import subprocess
import tempfile
from threading import Thread
import unittest


PROJECT = Path(__file__).resolve().parents[1]
PLUGIN = PROJECT / "plugins" / "task-reuse"
TOOL_NAMES = {"inspect_csv", "preview_recipe", "run_recipe"}


class JsonLinesProcess:
    def __init__(self, command, *, cwd, env):
        self.stderr = tempfile.TemporaryFile()
        try:
            self.process = subprocess.Popen(
                command,
                cwd=cwd,
                env=env,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=self.stderr,
                text=True,
                encoding="utf-8",
            )
        except BaseException:
            self.stderr.close()
            raise
        self.events = Queue()
        self.next_id = 1
        self.reader = Thread(target=self.read_stdout, daemon=True)
        self.reader.start()

    def read_stdout(self):
        try:
            for line in self.process.stdout:
                self.events.put(json.loads(line))
        except (OSError, ValueError) as exc:
            self.events.put(exc)
        finally:
            self.events.put(None)

    def send(self, message):
        self.process.stdin.write(json.dumps(message) + "\n")
        self.process.stdin.flush()

    def request(self, method, params=None, *, timeout=15):
        identifier = self.next_id
        self.next_id += 1
        message = {"jsonrpc": "2.0", "id": identifier, "method": method}
        if params is not None:
            message["params"] = params
        self.send(message)
        while True:
            try:
                response = self.events.get(timeout=timeout)
            except Empty as exc:
                raise AssertionError(f"No response for {method}. {self.diagnostics()}") from exc
            if response is None or isinstance(response, Exception):
                raise AssertionError(f"Invalid stdout for {method}: {response}. {self.diagnostics()}")
            if response.get("id") == identifier:
                return response

    def diagnostics(self):
        self.stderr.seek(0)
        return self.stderr.read(3000).decode("utf-8", errors="replace")

    def close(self):
        try:
            self.process.stdin.close()
            try:
                self.process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait(timeout=3)
        finally:
            self.reader.join(timeout=3)
            self.process.stdout.close()
            self.stderr.close()


class PackagingTests(unittest.TestCase):
    def test_marketplace_points_to_plugin_and_bundled_skill(self):
        marketplace = json.loads((PROJECT / ".agents/plugins/marketplace.json").read_text(encoding="utf-8"))
        plugin = json.loads((PLUGIN / "plugin.json").read_text(encoding="utf-8"))
        entry = next(item for item in marketplace["plugins"] if item["name"] == plugin["name"])
        self.assertEqual(entry["source"]["source"], "local")
        self.assertEqual((PROJECT / entry["source"]["path"]).resolve(), PLUGIN)
        self.assertTrue((PLUGIN / "skills/task-reuse/SKILL.md").is_file())


class McpSession(unittest.TestCase):
    server_args = ()

    def setUp(self):
        temp = tempfile.TemporaryDirectory(prefix="task-reuse-mcp-", dir=Path(__file__).parent)
        self.addCleanup(temp.cleanup)
        self.workspace = Path(temp.name)
        env = os.environ.copy()
        env["TASK_REUSE_WORKSPACE"] = str(self.workspace)
        env["PYTHONDONTWRITEBYTECODE"] = "1"
        config = json.loads((PLUGIN / "mcp.json").read_text(encoding="utf-8"))
        server, = config["mcpServers"].values()
        self.assertEqual(server["type"], "stdio")
        command = [server["command"], *server.get("args", [])]
        command = [argument.replace("${PLUGIN_ROOT}", str(PLUGIN)) for argument in command]
        cwd = server.get("cwd", "${PLUGIN_ROOT}").replace("${PLUGIN_ROOT}", str(PLUGIN))
        self.client = JsonLinesProcess([*command, *self.server_args], cwd=cwd, env=env)
        self.addCleanup(self.client.close)
        init = self.client.request("initialize", {
            "protocolVersion": "2025-06-18",
            "clientInfo": {"name": "task-reuse-test", "version": "1"},
            "capabilities": {},
        })
        self.assertEqual(init["result"]["protocolVersion"], "2025-06-18")
        self.assertIn("tools", init["result"]["capabilities"])
        self.client.send({"jsonrpc": "2.0", "method": "notifications/initialized"})

    def call(self, tool, **arguments):
        response = self.client.request("tools/call", {"name": tool, "arguments": arguments})
        self.assertNotIn("error", response, response)
        return response["result"]

    def result(self, tool, **arguments):
        result = self.call(tool, **arguments)
        self.assertFalse(result.get("isError"), result)
        return result["structuredContent"]

    def write_sample(self, name, header, rows):
        with (self.workspace / name).open("w", encoding="utf-8-sig", newline="") as stream:
            writer = csv.writer(stream)
            writer.writerow(header)
            writer.writerows(rows)


class McpTests(McpSession):
    def test_manifest_launch_and_tools_follow_full_workflow(self):
        listed = self.client.request("tools/list")["result"]["tools"]
        self.assertEqual({tool["name"] for tool in listed}, TOOL_NAMES)
        for tool in listed:
            self.assertNotIn("workspace", tool["inputSchema"].get("properties", {}))

        header = ["邮箱", "报名时间", "说明"]
        winner = ["first@example.invalid", "2026-11-01T12:00:00+08:00", "私人测试标记"]
        older = ["FIRST@example.invalid", "2026-11-01T11:00:00+08:00", "旧行"]
        self.write_sample("报名表.csv", header, [winner, older])
        inspected = self.result("inspect_csv", path="报名表.csv")
        self.assertEqual(inspected["columns"], header)
        choice = self.result("preview_recipe", input_id=inspected["input_id"], key="邮箱")
        self.assertEqual(choice["status"], "needs_choice")
        self.assertNotIn("私人测试标记", json.dumps([inspected, choice], ensure_ascii=False))
        ready = self.result(
            "preview_recipe", input_id=inspected["input_id"], key="邮箱",
            keep="latest_timestamp", time_column="报名时间",
        )
        self.assertEqual(ready["status"], "ready")
        applied = self.result("run_recipe", plan_id=ready["plan_id"], save_as="attendance")
        self.assertEqual(applied["status"], "completed")
        self.assertEqual(applied["output_rows"], 1)
        with (self.workspace / applied["output_path"]).open(encoding="utf-8-sig", newline="") as stream:
            self.assertEqual(list(csv.reader(stream)), [header, winner])

        self.write_sample("下周.csv", header, [older])
        replay = self.result("run_recipe", recipe_id="attendance", input_path="下周.csv")
        self.assertEqual(replay["status"], "completed")
        self.assertEqual(replay["model_calls"], 0)
        with (self.workspace / replay["output_path"]).open(encoding="utf-8-sig", newline="") as stream:
            self.assertEqual(list(csv.reader(stream)), [header, older])

    def test_path_validation_reports_an_mcp_tool_error(self):
        result = self.call("inspect_csv", path="../outside.csv")
        self.assertTrue(result["isError"])
        self.assertEqual(result["structuredContent"]["status"], "error")
        self.assertTrue(result["structuredContent"]["code"])


class DshMcpTests(McpSession):
    server_args = ("--dsh",)
    header = ["邮箱", "报名时间", "备注"]
    winner = ["first@example.invalid", "2026-11-01T12:00:00+08:00", "私人测试标记"]
    older = ["FIRST@example.invalid", "2026-11-01T11:00:00+08:00", "旧行"]

    def outputs(self):
        return set((self.workspace / "task-reuse-output").glob("*.csv"))

    def verify_output(self, receipt, header, row):
        self.assertEqual(receipt["status"], "completed")
        self.assertEqual(receipt["output_rows"], 1)
        self.assertEqual(receipt["model_calls"], 0)
        self.assertTrue(receipt["checks"])
        with Path(receipt["output_path"]).open(encoding="utf-8-sig", newline="") as stream:
            self.assertEqual(list(csv.reader(stream)), [header, row])

    def test_fused_tool_requests_only_missing_choices_and_previews_without_output(self):
        listed = self.client.request("tools/list")["result"]["tools"]
        self.assertEqual([tool["name"] for tool in listed], ["process_csv"])
        self.assertNotIn("workspace", listed[0]["inputSchema"]["properties"])
        self.write_sample("报名表.csv", self.header, [self.winner, self.older])
        no_key = self.result("process_csv", path="报名表.csv")
        self.assertEqual(no_key, {"status": "needs_key", "columns": self.header})
        no_strategy = self.result("process_csv", path="报名表.csv", key="邮箱")
        self.assertEqual(no_strategy["status"], "needs_choice")
        self.assertEqual({option["keep"] for option in no_strategy["choices"]}, {"last_row", "latest_timestamp"})
        self.assertNotIn("私人测试标记", json.dumps(no_strategy, ensure_ascii=False))
        no_time = self.result("process_csv", path="报名表.csv", key="邮箱", keep="latest_timestamp")
        self.assertEqual(no_time, {"status": "needs_time_column", "columns": ["报名时间", "备注"]})
        preview = self.result(
            "process_csv", path="报名表.csv", key="邮箱", keep="latest_timestamp", time_column="报名时间", preview=True,
        )
        self.assertEqual(preview["status"], "ready")
        self.assertEqual(preview["output_rows"], 1)
        self.assertNotIn("output_path", preview)
        self.assertFalse(self.outputs())
        confirmed = self.result("process_csv", plan_id=preview["plan_id"])
        self.verify_output(confirmed, self.header, self.winner)

    def test_fused_tool_rejects_invalid_fields_and_preview_mutation(self):
        self.write_sample("报名表.csv", self.header, [self.winner])
        for arguments in ({"preview": "true"}, {"keep": "best_guess"}, {"workspace": "elsewhere"}, {"command": "dir"}):
            with self.subTest(arguments=arguments):
                response = self.client.request("tools/call", {"name": "process_csv", "arguments": {"path": "报名表.csv", **arguments}})
                self.assertEqual(response["error"]["code"], -32602)
        refused = self.call("process_csv", path="报名表.csv", preview=True, save_as="attendance")
        self.assertTrue(refused["isError"])
        self.assertEqual(refused["structuredContent"]["code"], "invalid_run")
        refused = self.call("process_csv", plan_id="preview-id", path="报名表.csv")
        self.assertTrue(refused["isError"])
        self.assertEqual(refused["structuredContent"]["code"], "invalid_run")
        self.assertFalse(self.outputs())

    def test_fused_confirmed_run_replay_and_renamed_binding(self):
        self.write_sample("first.csv", self.header, [self.winner, self.older])
        first = self.result(
            "process_csv", path="first.csv", key="邮箱", keep="latest_timestamp", time_column="报名时间", save_as="attendance",
        )
        self.assertEqual(first["recipe_id"], "attendance")
        self.assertEqual(first["recipe_revision"], 1)
        self.verify_output(first, self.header, self.winner)

        self.write_sample("next.csv", self.header, [self.older])
        self.verify_output(self.result("process_csv", path="next.csv", recipe_id="attendance"), self.header, self.older)

        renamed = ["邮箱", "提交时间", "备注"]
        self.write_sample("renamed.csv", renamed, [self.winner, self.older])
        before = self.outputs()
        drift = self.result("process_csv", path="renamed.csv", recipe_id="attendance")
        self.assertEqual(drift["status"], "needs_binding")
        self.assertEqual(drift["missing_columns"], ["报名时间"])
        self.assertEqual(self.outputs(), before)
        repaired = self.result("process_csv", path="renamed.csv", recipe_id="attendance", replacement="提交时间", save_as="attendance")
        self.assertEqual(repaired["recipe_revision"], 2)
        self.verify_output(repaired, renamed, self.winner)
        self.verify_output(self.result("process_csv", path="renamed.csv", recipe_id="attendance"), renamed, self.winner)
        self.verify_output(self.result("process_csv", path="first.csv", recipe_id="attendance"), self.header, self.winner)


if __name__ == "__main__":
    unittest.main()
