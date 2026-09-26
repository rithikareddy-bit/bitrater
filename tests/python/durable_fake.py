"""Minimal deterministic driver for Durable orchestrator generators (tests only)."""
from datetime import datetime, timezone


class FakeSubTask:
    """A scheduled sub-orchestration; runs when the parent yields it (directly or via task_any)."""

    def __init__(self, name, inp, instance_id):
        self.name, self.inp, self.instance_id = name, inp, instance_id
        self.result, self.is_completed = None, False


class FakeCtx:
    def __init__(self, inp, instance_id="inst"):
        self._input, self.instance_id = inp, instance_id
        self.current_utc_datetime = datetime(2026, 9, 26, tzinfo=timezone.utc)
        self.continued = None

    def get_input(self):
        return self._input

    def call_activity(self, name, req):
        return ("activity", name, req)

    def create_timer(self, fire_at):
        return ("timer", fire_at)

    def call_sub_orchestrator(self, name, inp, instance_id=None):
        return FakeSubTask(name, inp, instance_id)

    def task_any(self, tasks):
        return ("any", tasks)

    def continue_as_new(self, inp):
        self.continued = inp


class Run:
    """Drives an orchestrator. `activity(module, event)` returns a result (or error dict).

    Sub-orchestrators run eagerly; a failing child is thrown back into the parent
    at its yield, as Durable does.
    """

    def __init__(self, activity, orchestrators=None):
        self.activity, self.orchs = activity, orchestrators or {}
        self.calls, self.waits, self.window_sizes = [], [], []

    def _run_sub(self, sub):
        sub.result, _ = self.drive(self.orchs[sub.name], sub.inp, sub.instance_id)
        sub.is_completed = True

    def drive(self, fn, inp, instance_id="inst"):
        ctx = FakeCtx(inp, instance_id)
        gen, value, exc = fn(ctx), None, None
        while True:
            try:
                task = gen.throw(exc) if exc else gen.send(value)
            except StopIteration as stop:
                return stop.value, ctx
            value, exc = None, None
            if isinstance(task, FakeSubTask):
                try:
                    self._run_sub(task)
                    value = task.result
                except Exception as err:  # noqa: BLE001 - child failure raises at the parent's yield
                    exc = err
                continue
            kind = task[0]
            if kind == "activity":
                req = task[2]
                self.calls.append((req["module"], req["event"]))
                value = self.activity(req["module"], req["event"])
            elif kind == "timer":
                self.waits.append((task[1] - ctx.current_utc_datetime).total_seconds())
                ctx.current_utc_datetime = task[1]
            elif kind == "any":
                tasks = task[1]
                self.window_sizes.append(len(tasks))
                first = next(t for t in tasks if not t.is_completed)
                self._run_sub(first)
                value = first
