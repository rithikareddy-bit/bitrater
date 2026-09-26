"""Step Functions semantics for Durable orchestrators.

The ported orchestrators must behave exactly like orchestrator/*step_function*.json:
  - Task = run an unchanged orchestrator/<module>.py handler (activity `run_handler`)
  - Retry: IntervalSeconds / MaxAttempts / BackoffRate, where MaxAttempts counts
    RETRIES (SFN semantics: MaxAttempts=2 -> up to 3 calls), delays via durable timers
  - Catch: a failed task surfaces as TaskError carrying the Lambda-style error
    payload, so `cause` strings stay identical ({"errorMessage", "errorType", ...})
  - ResultSelector / Parameters: pick() fails on a missing key, like a JSONPath
    miss fails an SFN state (States.Runtime)

Everything here is deterministic (only ctx time/timers), as orchestrators require.
"""
import json
from datetime import timedelta

ERROR_KEY = "__lambda_error__"


class TaskError(Exception):
    """A task failed after its retries. .error is the Lambda-style error payload."""

    def __init__(self, error: dict):
        self.error = error
        super().__init__(error.get("errorMessage", "task failed"))

    @property
    def cause(self) -> str:
        # What SFN puts in $.xxxError.Cause for a Lambda task failure.
        return json.dumps(self.error)


class WorkflowFailed(Exception):
    """A Fail state: Error + Cause, as the execution's final failure."""

    def __init__(self, error: str, cause: str):
        self.error, self.cause = error, cause
        super().__init__(cause)


class PathMissing(Exception):
    """JSONPath referenced a missing field (SFN: States.Runtime, not retried or caught by TaskFailed)."""


def pick(source: dict, keys) -> dict:
    missing = [k for k in keys if k not in source]
    if missing:
        raise PathMissing(f"JSONPath fields not found: {missing}")
    return {k: source[k] for k in keys}


def call(ctx, module: str, payload):
    """One task attempt. Returns the handler result or raises TaskError.

    Failures of the activity itself (worker crash, output serialization, isolation
    refusal) also become TaskError, as SFN's States.ALL Catch would treat them.
    """
    try:
        result = yield ctx.call_activity("run_handler", {"module": module, "event": payload})
    except Exception as exc:  # noqa: BLE001
        raise TaskError({"errorMessage": str(exc), "errorType": type(exc).__name__, "stackTrace": []}) from exc
    if isinstance(result, dict) and ERROR_KEY in result:
        raise TaskError(result[ERROR_KEY])
    return result


def call_with_retry(ctx, module: str, payload, interval_s: float = 0, max_retries: int = 0, backoff: float = 1.0):
    """Task with an SFN Retry block. max_retries = the JSON's MaxAttempts."""
    retries = 0
    while True:
        try:
            return (yield from call(ctx, module, payload))
        except TaskError:
            if retries >= max_retries:
                raise
            delay = interval_s * (backoff ** retries)
            yield ctx.create_timer(ctx.current_utc_datetime + timedelta(seconds=delay))
            retries += 1


def wait(ctx, seconds: float):
    yield ctx.create_timer(ctx.current_utc_datetime + timedelta(seconds=seconds))
