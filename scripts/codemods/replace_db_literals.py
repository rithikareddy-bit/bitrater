#!/usr/bin/env python3
"""Replace hard-coded Mongo DB / CDN bucket names with runtime_config lookups.

Pure rename: every replacement resolves to the same literal when the env var is
unset (see orchestrator/runtime_config.py). scripts/codemods/verify_equivalence.py
proves the diff is nothing but these substitutions.

Usage: python scripts/codemods/replace_db_literals.py [--check]
  --check  exit 1 if any file would change (used by tests after the codemod ran)
"""
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]

# Modules that run on Azure (ported Lambdas). They can import runtime_config.
ORCHESTRATOR_MODULES = [
    "aggregator.py", "audio_subtitle_publish.py", "gcp_audio_transcoder.py",
    "gcp_check_audio_status.py", "gcp_check_status.py", "gcp_copy_audio_to_gcs.py",
    "gcp_copy_s3_to_gcs.py", "gcp_create_combined_master.py", "gcp_finalize_hls.py",
    "gcp_transcoder.py", "list_audio_episodes.py", "mark_lab_failed.py",
    "quality_checker.py", "resign_playback_urls.py", "resync_subtitles.py",
    "search_orchestrator.py", "url_health_checker.py",
]
# Separate container images: no runtime_config, a local DB_LAB constant instead.
WORKERS = ["research-worker/worker.py", "audio-visqol-worker/worker.py"]

# Operator scripts that are NOT ported and keep their literals (explicit allowlist,
# enforced by tests/python/test_no_hardcoded_literals.py).
ALLOWLIST = [
    "orchestrator/batch_strip_manifests.py", "orchestrator/fix_subtitle_timestamp_map.py",
    "orchestrator/patch_gcs_cache_control.py", "orchestrator/strip_manifest_params.py",
    "orchestrator/lambda_trigger.py",
]

ORCH_RULES = [
    (re.compile(r'\["chai_q_lab"\]'), "[runtime_config.DB_LAB]"),
    (re.compile(r"\b(client)\.chai_q_lab\b"), r"\1[runtime_config.DB_LAB]"),
    (re.compile(r'\b((?:mongo_|m)?client)\["master"\]'), r"\1[runtime_config.DB_MASTER]"),
    (re.compile(r'\["gld2sqs"\]'), "[runtime_config.DB_SUBTITLES]"),
    (re.compile(r'^CDN_BUCKET = "chai-shots-manifests"', re.M), "CDN_BUCKET = runtime_config.CDN_BUCKET"),
]
WORKER_RULES = [(re.compile(r'\["chai_q_lab"\]'), "[DB_LAB]")]


def _insert_after_imports(src: str, line: str) -> str:
    """Insert `line` after the module's leading block of top-level imports."""
    lines = src.splitlines(keepends=True)
    last, i, seen = None, 0, False
    while i < len(lines):
        text = lines[i]
        if re.match(r"(import |from \S+ import )", text):
            seen = True
            if "(" in text and ")" not in text:  # parenthesised multi-line import
                while ")" not in lines[i]:
                    i += 1
            last = i
        elif seen and re.match(r"(def |class |@|if |try:|[A-Za-z_][A-Za-z0-9_]* *=)", text):
            break
        i += 1
    if last is None:
        raise ValueError("no top-level import found")
    lines.insert(last + 1, line + "\n")
    return "".join(lines)


def transform_orchestrator(src: str) -> str:
    out = src
    for pattern, repl in ORCH_RULES:
        out = pattern.sub(repl, out)
    if out != src and "import runtime_config" not in out:
        out = _insert_after_imports(out, "import runtime_config")
    return out


def transform_worker(src: str) -> str:
    out = src
    for pattern, repl in WORKER_RULES:
        out = pattern.sub(repl, out)
    if out != src and "\nDB_LAB = " not in out:
        out = _insert_after_imports(
            out, 'DB_LAB = os.environ.get("DB_LAB", "chai_q_lab")  # Azure shadow isolation (AZURE-MIGRATION-PLAN.md P2)')
    return out


def main(check: bool) -> int:
    changed = []
    targets = [(ROOT / "orchestrator" / m, transform_orchestrator) for m in ORCHESTRATOR_MODULES]
    targets += [(ROOT / w, transform_worker) for w in WORKERS]
    for path, fn in targets:
        src = path.read_text()
        out = fn(src)
        if out != src:
            changed.append(str(path.relative_to(ROOT)))
            if not check:
                path.write_text(out)
    for c in changed:
        print(("would change: " if check else "changed: ") + c)
    return 1 if (check and changed) else 0


if __name__ == "__main__":
    sys.exit(main("--check" in sys.argv))
