#!/usr/bin/env python3
"""Prove a codemod diff is a pure rename (no behaviour change with env unset).

For every file changed between two git revisions, substitute each config lookup
back to the literal it defaults to and require the result to equal the original
file, ignoring only the added `import runtime_config` / `DB_LAB = ...` lines
(and their JS equivalents).

Usage: python scripts/codemods/verify_equivalence.py <base-rev> <new-rev>
"""
import re
import subprocess
import sys

# config expression -> literal it defaults to
BACK_SUBS = [
    (r"\[runtime_config\.DB_LAB\]", '["chai_q_lab"]'),
    (r"\[runtime_config\.DB_MASTER\]", '["master"]'),
    (r"\[runtime_config\.DB_SUBTITLES\]", '["gld2sqs"]'),
    (r"runtime_config\.CDN_BUCKET", '"chai-shots-manifests"'),
    (r"\[DB_LAB\]", '["chai_q_lab"]'),
    (r"db\(DB_LAB\)", "db('chai_q_lab')"),
    (r"db\(DB_MASTER\)", "db('master')"),
    (r"db\(DB_DEV\)", "db('gld2sqs')"),
]
# lines the codemod adds that have no counterpart in the original
ADDED_LINE = re.compile(
    r"^(import runtime_config|DB_LAB = os\.environ\.get\(\"DB_LAB\", \"chai_q_lab\"\).*"
    r"|import \{ [A-Z_, ]+ \} from '@/lib/config';)$"
)
# aggregator.py: `client.chai_q_lab` became `client[runtime_config.DB_LAB]`
SPECIAL = [(r'client\["chai_q_lab"\]', "client.chai_q_lab")]


def git(*args) -> str:
    return subprocess.run(["git", *args], check=True, capture_output=True, text=True).stdout


def normalise(new_src: str, old_src: str) -> str:
    out = new_src
    for pat, lit in BACK_SUBS:
        out = re.sub(pat, lit, out)
    lines = [l for l in out.split("\n") if not ADDED_LINE.match(l)]
    out = "\n".join(lines)
    if out != old_src:
        for pat, lit in SPECIAL:
            candidate = re.sub(pat, lit, out)
            if candidate == old_src:
                return candidate
    return out


def main(base: str, new: str) -> int:
    files = [f for f in git("diff", "--name-only", base, new).split() if f.endswith((".py", ".js", ".ts", ".mjs"))]
    bad = []
    for f in files:
        try:
            old_src = git("show", f"{base}:{f}")
        except subprocess.CalledProcessError:
            bad.append(f"{f}: new file (codemod must not add files)")
            continue
        if normalise(git("show", f"{new}:{f}"), old_src) != old_src:
            bad.append(f)
    for b in bad:
        print("NOT a pure rename:", b)
    print(f"checked {len(files)} files, {len(bad)} problems")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1], sys.argv[2]))
