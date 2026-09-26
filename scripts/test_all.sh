#!/usr/bin/env bash
# Run every test suite; non-zero exit if any fails. Run before each commit.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
"$ROOT/.venv/bin/python" -m pytest -q "$ROOT/tests/python" -c "$ROOT/pytest.ini" --rootdir "$ROOT"
(cd "$ROOT/dashboard" && npx vitest run --reporter=dot)
echo "ALL TESTS PASSED"
