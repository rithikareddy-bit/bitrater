"""After the codemod, prod DB/bucket names may only appear in config modules or allowlisted scripts."""
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts" / "codemods"))
import replace_db_literals as codemod  # noqa: E402
import verify_equivalence  # noqa: E402

PY_PATTERNS = [r'\["chai_q_lab"\]', r"\.chai_q_lab\b", r'client\["master"\]', r'\["gld2sqs"\]',
               r'^CDN_BUCKET = "chai-shots-manifests"']
JS_PATTERNS = [r"db\(['\"](chai_q_lab|master|gld2sqs)['\"]\)"]


def _scan(files, patterns):
    hits = []
    for f in files:
        text = f.read_text()
        for p in patterns:
            for m in re.finditer(p, text, re.M):
                line = text[: m.start()].count("\n") + 1
                hits.append(f"{f.relative_to(ROOT)}:{line}: {m.group(0)}")
    return hits


def test_no_python_literals_outside_allowlist():
    allow = {ROOT / a for a in codemod.ALLOWLIST} | {ROOT / "orchestrator" / "runtime_config.py"}
    files = [f for f in (ROOT / "orchestrator").glob("*.py") if f not in allow]
    files += [ROOT / w for w in codemod.WORKERS]
    assert _scan(files, PY_PATTERNS) == []


def test_no_dashboard_literals():
    files = [f for d in ("app", "lib", "components") for f in (ROOT / "dashboard" / d).rglob("*")
             if f.suffix in {".js", ".mjs", ".ts", ".tsx", ".jsx"} and f.name != "config.js"]
    assert _scan(files, JS_PATTERNS) == []


def test_codemod_is_idempotent():
    assert codemod.main(check=True) == 0


def test_verifier_accepts_pure_rename():
    old = 'import os\ndb = client["chai_q_lab"]\n'
    new = 'import os\nimport runtime_config\ndb = client[runtime_config.DB_LAB]\n'
    assert verify_equivalence.normalise(new, old) == old


def test_verifier_rejects_behaviour_change():
    old = 'import os\ndb = client["chai_q_lab"]\n'
    sneaky = 'import os\nimport runtime_config\ndb = client[runtime_config.DB_MASTER]\n'
    assert verify_equivalence.normalise(sneaky, old) != old
