"""Runtime names that differ between prod and the Azure shadow stamp.

Every default equals the literal the code used before the Azure migration, so a
process with none of these env vars set behaves exactly like AWS prod today
(tests/python/test_runtime_config.py proves it). The Azure shadow stamp sets
SHADOW_MODE=true plus shadow names; assert_isolation() then refuses to run if
any name could reach prod data. See AZURE-MIGRATION-PLAN.md §0 (P2).

Stdlib only: imported by every Lambda/activity/job at module load.
"""
import os

DB_LAB = os.environ.get("DB_LAB", "chai_q_lab")
DB_MASTER = os.environ.get("DB_MASTER", "master")
DB_SUBTITLES = os.environ.get("DB_SUBTITLES", "gld2sqs")  # read-only from this code
CDN_BUCKET = os.environ.get("CDN_BUCKET", "chai-shots-manifests")

CLOUD_PROVIDER = os.environ.get("CLOUD_PROVIDER", "aws")
SHADOW_MODE = os.environ.get("SHADOW_MODE", "false").lower() == "true"

SHADOW_DB_SUFFIX = "_shadow"
SHADOW_BUCKET_PREFIX = "chai-q-az-shadow-"

# Bucket env vars the existing handlers already read directly from os.environ.
_BUCKET_ENV_VARS = ("GCS_INPUT_BUCKET", "GCS_OUTPUT_BUCKET", "AUDIO_PUBLIC_BUCKET", "AUDIO_GCS_BUCKET")


class IsolationError(RuntimeError):
    """A shadow-mode process is configured with a name that points at prod."""


def isolation_violations(environ=None) -> list:
    """Return every reason the current config could touch prod in shadow mode.

    Empty when SHADOW_MODE is off (prod) or when every name is a shadow name.
    """
    env = os.environ if environ is None else environ
    if env.get("SHADOW_MODE", "false").lower() != "true":
        return []

    problems = []
    for var, default in (("DB_LAB", "chai_q_lab"), ("DB_MASTER", "master")):
        value = env.get(var, default)
        if not value.endswith(SHADOW_DB_SUFFIX):
            problems.append(f"{var}={value!r} must end with {SHADOW_DB_SUFFIX!r}")

    cdn = env.get("CDN_BUCKET", "chai-shots-manifests")
    if not cdn.startswith(SHADOW_BUCKET_PREFIX):
        problems.append(f"CDN_BUCKET={cdn!r} must start with {SHADOW_BUCKET_PREFIX!r}")
    for var in _BUCKET_ENV_VARS:
        value = env.get(var)
        if value is not None and not value.startswith(SHADOW_BUCKET_PREFIX):
            problems.append(f"{var}={value!r} must start with {SHADOW_BUCKET_PREFIX!r}")

    if env.get("RESIGN_INVOKE_MODE", "lambda") != "inprocess":
        problems.append("RESIGN_INVOKE_MODE must be 'inprocess' (resync would call the prod resigner Lambda)")
    if env.get("SKIP_CDN_INVALIDATION") != "1":
        problems.append("SKIP_CDN_INVALIDATION must be '1' (shadow must never purge the prod Media CDN)")
    return problems


# Scheduled jobs (azure-jobs/run_job.py) only READ DB_MASTER and write DB_LAB. In a
# shadow stamp they may read prod master (Phase F resigner dry run, G1 url-health
# compare), so the full check above (which requires DB_MASTER=*_shadow) does not fit.
JOB_NAMES = ("resigner", "url_health", "batch_cleanup", "workflow_watchdog")


def job_isolation_violations(job: str, environ=None) -> list:
    """Shadow rules for a scheduled job: every write goes to *_shadow; the resigner stays dry."""
    env = os.environ if environ is None else environ
    if job not in JOB_NAMES:
        return [f"unknown job {job!r}"]
    if env.get("SHADOW_MODE", "false").lower() != "true":
        return []
    problems = []
    db_lab = env.get("DB_LAB", "chai_q_lab")
    if not db_lab.endswith(SHADOW_DB_SUFFIX):
        problems.append(f"DB_LAB={db_lab!r} must end with {SHADOW_DB_SUFFIX!r} (jobs write run logs there)")
    if job == "resigner" and env.get("DRY_RUN", "true").lower() == "false":
        problems.append("a shadow resigner must stay DRY_RUN (it reads prod master)")
    return problems


def assert_job_isolation(job: str, environ=None) -> None:
    problems = job_isolation_violations(job, environ)
    if problems:
        raise IsolationError("Shadow job isolation check failed: " + "; ".join(problems))


def assert_isolation(environ=None) -> None:
    """Raise IsolationError if a shadow-mode process could write prod. No-op in prod."""
    problems = isolation_violations(environ)
    if problems:
        raise IsolationError("Shadow isolation check failed: " + "; ".join(problems))
