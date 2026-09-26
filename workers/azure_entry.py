"""Azure Batch entrypoint for the worker images (stdlib only).

Replaces AWS Batch's plaintext MONGO_URI in the job definition: reads secrets
from Key Vault with the pool's managed identity (IMDS), exports them as the env
vars worker.py already reads, then execs worker.py unchanged.

  KEY_VAULT_URL          https://kv-bitrater-prod.vault.azure.net
  MONGO_URI_KV_SECRET    Key Vault secret name holding the Mongo URI
  AWS_S3_KEY_KV_SECRET   optional: secret holding {"access_key_id","secret_access_key"}
                         (read-only S3 key, for sources whose s3_url is still on S3)
"""
import json
import os
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
        key = json.loads(secret_fn(vault, environ["AWS_S3_KEY_KV_SECRET"], token))
        environ["AWS_ACCESS_KEY_ID"] = key["access_key_id"]
        environ["AWS_SECRET_ACCESS_KEY"] = key["secret_access_key"]
        environ.setdefault("AWS_DEFAULT_REGION", "ap-south-2")


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


if __name__ == "__main__":
    load_secrets()
    prepare_workdir()
    os.execvp(sys.executable, [sys.executable, "/var/task/worker.py", *sys.argv[1:]])
