"""Azure Batch entrypoint for the worker images (stdlib only).

Replaces AWS Batch's plaintext MONGO_URI in the job definition: reads secrets
from Key Vault with the pool's managed identity (IMDS), exports them as the env
vars worker.py already reads, then execs worker.py unchanged.

  KEY_VAULT_URL          https://kv-bitrater-prod.vault.azure.net
  MONGO_URI_KV_SECRET    Key Vault secret name holding the Mongo URI
  AWS_S3_KEY_KV_SECRET   optional: secret holding {"access_key_id","secret_access_key"}
                         (read-only S3 key, for sources whose s3_url is still on S3)
  STAMP_DB_LAB           set on the Batch JOB by Terraform (not by the submitter): the
                         only lab DB this stamp's tasks may write (isolation check)
"""
import json
import os
import shutil
import signal
import subprocess
import sys
import urllib.parse
import urllib.request

IMDS = "http://169.254.169.254/metadata/identity/oauth2/token"


def _token(resource: str) -> str:
    params = {"api-version": "2018-02-01", "resource": resource}
    client_id = os.environ.get("AZURE_CLIENT_ID_BATCH") or os.environ.get("AZURE_CLIENT_ID")
    if client_id:  # user-assigned identity on the pool
        params["client_id"] = client_id
    req = urllib.request.Request(f"{IMDS}?{urllib.parse.urlencode(params)}", headers={"Metadata": "true"})
    with urllib.request.urlopen(req, timeout=10) as resp:
        return json.load(resp)["access_token"]


def _secret(vault: str, name: str, token: str) -> str:
    req = urllib.request.Request(f"{vault.rstrip('/')}/secrets/{urllib.parse.quote(name)}?api-version=7.4",
                                 headers={"Authorization": f"Bearer {token}"})
    with urllib.request.urlopen(req, timeout=10) as resp:
        return json.load(resp)["value"]


def load_secrets(environ=os.environ, token_fn=_token, secret_fn=_secret) -> None:
    vault = environ.get("KEY_VAULT_URL")
    if not vault:
        return  # nothing to load (e.g. local run with MONGO_URI already set)
    token = token_fn("https://vault.azure.net")
    if environ.get("MONGO_URI_KV_SECRET"):
        environ["MONGO_URI"] = secret_fn(vault, environ["MONGO_URI_KV_SECRET"], token)
    if environ.get("AWS_S3_KEY_KV_SECRET"):
        # Best effort: only sources still on S3 need it. Azure-Blob sources and ViSQOL
        # (public HTTPS inputs) must not fail because the S3 key is absent.
        try:
            key = json.loads(secret_fn(vault, environ["AWS_S3_KEY_KV_SECRET"], token))
            environ["AWS_ACCESS_KEY_ID"] = key["access_key_id"]
            environ["AWS_SECRET_ACCESS_KEY"] = key["secret_access_key"]
            environ.setdefault("AWS_DEFAULT_REGION", "ap-south-2")
        except Exception as exc:  # noqa: BLE001
            print(f"WARNING: AWS S3 key {environ['AWS_S3_KEY_KV_SECRET']!r} unavailable ({type(exc).__name__}); "
                  "S3 sources will fail, HTTP/Blob sources are unaffected", file=sys.stderr)


def prepare_workdir(environ=os.environ, image_dir="/var/task") -> str:
    """Run in the Batch task directory (on the node's temp disk, not the container layer).

    worker.py writes source.mp4 / variant.mp4 (11 GB+ sources) to its cwd and reads
    configs/ relative to it (image WORKDIR /var/task on AWS), so link configs/ in.
    """
    workdir = environ.get("AZ_BATCH_TASK_WORKING_DIR")
    if not workdir or not os.path.isdir(workdir):
        if environ.get("AZ_BATCH_TASK_ID"):
            print(f"WARNING: AZ_BATCH_TASK_WORKING_DIR not usable ({workdir!r}); "
                  "working in the container layer (OS disk)", file=sys.stderr)
        return os.getcwd()
    os.chdir(workdir)
    environ["TMPDIR"] = workdir  # ViSQOL's tempfile.mkdtemp() also lands on the temp disk
    src = os.path.join(image_dir, "configs")
    if os.path.isdir(src) and not os.path.exists("configs"):
        os.symlink(src, "configs")
    return workdir


def check_isolation(environ=os.environ) -> None:
    """Refuse to run if the task's DB_LAB differs from the one its Batch job allows.

    STAMP_DB_LAB comes from the job's common environment (Terraform), so a shadow task
    can't reach prod chai_q_lab even if the submitter's env passthrough drops DB_LAB
    (worker.py falls back to chai_q_lab). Raises SystemExit before any secret is read.
    """
    allowed = environ.get("STAMP_DB_LAB")
    if not allowed:
        return  # not on an Azure Batch job (local run)
    db_lab = environ.setdefault("DB_LAB", allowed)
    if db_lab != allowed:
        raise SystemExit(f"ISOLATION_FAILED: DB_LAB={db_lab!r} but this Batch job only allows {allowed!r}")


def cleanup_workdir(workdir: str, environ=os.environ) -> None:
    """Delete the task's files (source.mp4 / variant.mp4, 11 GB+) as soon as the worker exits.

    On AWS they died with the container layer; here they sit on the node's shared temp
    disk, and back-to-back tasks on one node would fill it. Only inside a Batch task dir.
    """
    if not environ.get("AZ_BATCH_TASK_WORKING_DIR") or workdir != environ["AZ_BATCH_TASK_WORKING_DIR"]:
        return
    for name in os.listdir(workdir):
        path = os.path.join(workdir, name)
        try:
            if os.path.isdir(path) and not os.path.islink(path):
                shutil.rmtree(path, ignore_errors=True)
            else:
                os.remove(path)
        except OSError as exc:
            print(f"WARNING: cleanup of {path} failed: {exc}", file=sys.stderr)


def run_worker(argv, workdir: str, environ=os.environ, popen=subprocess.Popen) -> int:
    """Run worker.py as a child (not exec) so its files can be removed afterwards.

    Exit code is passed through unchanged; SIGTERM/SIGINT (Batch terminate) are forwarded.
    """
    child = popen([sys.executable, "/var/task/worker.py", *argv], env=dict(environ))
    forward = lambda sig, _frame: child.send_signal(sig)  # noqa: E731
    previous = {s: signal.signal(s, forward) for s in (signal.SIGTERM, signal.SIGINT)}
    try:
        code = child.wait()
    finally:
        for s, handler in previous.items():
            signal.signal(s, handler)
        cleanup_workdir(workdir, environ)
    return code if code >= 0 else 128 - code  # killed by signal N -> 128+N, like a shell


if __name__ == "__main__":
    check_isolation()
    load_secrets()
    sys.exit(run_worker(sys.argv[1:], prepare_workdir()))
