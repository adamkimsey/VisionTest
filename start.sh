#!/bin/bash
# Starts VisionTest on Mac or Linux. The first run installs the libraries (a few minutes).
set -e
cd "$(dirname "$0")"
PY=python3
if [ ! -d .venv ]; then
  echo "First run: installing libraries. This takes a few minutes."
  $PY -m venv .venv
  .venv/bin/pip install --upgrade pip
  .venv/bin/pip install -r requirements.txt
fi
echo "VisionTest is starting. Open http://localhost:8000 in Chrome."
(sleep 4 && (open http://localhost:8000 2>/dev/null || xdg-open http://localhost:8000 2>/dev/null || true)) &
exec .venv/bin/python -m uvicorn app.main:app --host 127.0.0.1 --port 8000
