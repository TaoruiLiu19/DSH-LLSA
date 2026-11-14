"""Private stdin/stdout bridge for LLSA. All paths are fixed inside the process workspace."""

import json
import sys
from pathlib import Path

from csv_core import MAX_BYTES, TaskError, digest
from csv_pipeline import MAX_PLAN_BYTES, execute_pipeline


def read_input(path):
    with path.open("rb") as stream:
        return stream.read(MAX_BYTES + 1)


def main():
    input_path = Path("input.csv")
    try:
        data = sys.stdin.buffer.read(MAX_PLAN_BYTES + 1)
        if len(data) > MAX_PLAN_BYTES:
            raise TaskError("invalid_steps", "流程配置最多为 64 KiB。")
        request = json.loads(data)
        if not isinstance(request, dict) or request.keys() != {"steps"}:
            raise TaskError("invalid_steps", "流程配置只接受 steps。")
        source = read_input(input_path)
        output, receipt = execute_pipeline(source, request["steps"])
        if read_input(input_path) != source:
            raise TaskError("input_changed", "输入在执行期间发生变化。")
        output_ref = f"csv-output/{digest(output)}.csv"
        path = Path(output_ref)
        path.parent.mkdir()
        with path.open("xb") as stream:
            stream.write(output)
        return {**receipt, "output_ref": output_ref, "checks": [*receipt["checks"], "input_unchanged"]}
    except TaskError as error:
        result = {"status": "error", "code": error.code, "message": error.message}
        if hasattr(error, "step"):
            result["step"] = error.step
        return result
    except (ValueError, RecursionError):
        return {"status": "error", "code": "invalid_steps", "message": "流程配置需要有效的 JSON。"}
    except OSError:
        return {"status": "error", "code": "io_error", "message": "无法读取输入或写出本机结果。"}


if __name__ == "__main__":
    print(json.dumps(main(), ensure_ascii=True, separators=(",", ":")))
