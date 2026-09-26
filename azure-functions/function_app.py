"""bitrater pipeline on Azure Functions (Flex Consumption, Python v2 model).

Durable orchestrators replace the AWS Step Functions; the activity runs the
unchanged orchestrator/*.py handlers (copied into orchestrator_src/ at build
time by scripts/build_functions.sh). See AZURE-MIGRATION-PLAN.md.
"""
import asyncio
import json
import logging
import os
import shutil
import stat
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "orchestrator_src"))


def _ensure_ffmpeg():
    """quality_checker runs bin/ffmpeg (same static build as the Lambda layer).

    The deployed package is read-only and may lose the exec bit, so copy the
    binaries to a writable temp dir when needed and point FFMPEG_PATH/FFPROBE_PATH there.
    """
    for name, var in (("ffmpeg", "FFMPEG_PATH"), ("ffprobe", "FFPROBE_PATH")):
        src = os.path.join(HERE, "bin", name)
        if not os.path.exists(src):
            continue
        if os.access(src, os.X_OK):
            os.environ[var] = src
            continue
        dst = os.path.join(tempfile.gettempdir(), "bitrater-bin", name)
        if not os.access(dst, os.X_OK):
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            tmp = f"{dst}.tmp.{os.getpid()}"  # atomic: never leave a half-written binary
            shutil.copyfile(src, tmp)
            os.chmod(tmp, os.stat(tmp).st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
            os.replace(tmp, dst)
        os.environ[var] = dst


try:
    _ensure_ffmpeg()
except Exception as exc:  # noqa: BLE001 - only quality-check needs ffmpeg; never take the app down
    logging.exception("ffmpeg setup failed (quality-check will fail): %s", exc)

import azure.durable_functions as df  # noqa: E402
import azure.functions as func  # noqa: E402

from bitrater_wf import handlers, orchestrators  # noqa: E402
from bitrater_wf.sfn import ERROR_KEY  # noqa: E402

app = df.DFApp(http_auth_level=func.AuthLevel.FUNCTION)

# Orchestrators: thin generator wrappers around bitrater_wf.orchestrators.


@app.orchestration_trigger(context_name="context")
def lab_search(context):
    return (yield from orchestrators.lab_search(context))


@app.orchestration_trigger(context_name="context")
def gcp_transcode(context):
    return (yield from orchestrators.gcp_transcode(context))


@app.orchestration_trigger(context_name="context")
def audio_transcode(context):
    return (yield from orchestrators.audio_transcode(context))


@app.orchestration_trigger(context_name="context")
def audio_episode_tolerant(context):
    return (yield from orchestrators.audio_episode_tolerant(context))


@app.orchestration_trigger(context_name="context")
def audio_show_batch(context):
    return (yield from orchestrators.audio_show_batch(context))


@app.orchestration_trigger(context_name="context")
def invoke_async(context):
    return (yield from orchestrators.invoke_async(context))


@app.function_name(name="run_handler")
@app.activity_trigger(input_name="req")
def run_handler(req: dict):
    return handlers.run(req["module"], req["event"])


@app.function_name(name="invoke")
@app.route(route="invoke/{fn}", methods=["POST"])
@app.durable_client_input(client_name="client")
async def invoke(req: func.HttpRequest, client) -> func.HttpResponse:
    """Lambda Invoke equivalent for the dashboard (dashboard/lib/invoke.js).

    mode=sync  -> run in-process, 200 with the result or 500 with the Lambda error body
    mode=async -> Event invoke: start invoke_async (Lambda-style async retries), 202
    """
    module = handlers.INVOKE_FUNCTIONS.get(req.route_params.get("fn", ""))
    if not module:
        return func.HttpResponse(json.dumps({"errorMessage": "unknown function"}), status_code=404)
    try:
        event = req.get_json() if req.get_body() else {}
    except ValueError:
        return func.HttpResponse(json.dumps({"errorMessage": "invalid JSON"}), status_code=400)

    if req.params.get("mode") == "async":
        instance_id = await client.start_new("invoke_async", None, {"module": module, "event": event})
        return func.HttpResponse(json.dumps({"executionId": f"azdf:invoke_async:{instance_id}"}), status_code=202,
                                 mimetype="application/json")

    result = await asyncio.to_thread(handlers.run, module, event)
    if isinstance(result, dict) and ERROR_KEY in result:
        return func.HttpResponse(json.dumps(result[ERROR_KEY]), status_code=500, mimetype="application/json")
    return func.HttpResponse(json.dumps(result, default=str), status_code=200, mimetype="application/json")
