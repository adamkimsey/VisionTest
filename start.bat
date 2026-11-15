@echo off
rem Starts VisionTest on Windows. The first run installs the libraries (a few minutes).
cd /d "%~dp0"
if not exist .venv (
  echo First run: installing libraries. This takes a few minutes.
  python -m venv .venv
  .venv\Scripts\python -m pip install --upgrade pip
  .venv\Scripts\pip install -r requirements.txt
)
echo VisionTest is starting. Open http://localhost:8000 in Chrome.
start "" /b cmd /c "timeout /t 5 >nul & start http://localhost:8000"
.venv\Scripts\python -m uvicorn app.main:app --host 127.0.0.1 --port 8000
pause
