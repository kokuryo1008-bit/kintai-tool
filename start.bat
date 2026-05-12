@echo off
cd /d "%~dp0"
echo 勤怠管理システムを起動します...
if not exist backend\venv (
    echo 仮想環境を作成中...
    python -m venv backend\venv
)
call backend\venv\Scripts\activate
pip install -r backend\requirements.txt -q
echo.
echo ブラウザで http://localhost:8002 を開いてください
echo.
echo [管理者ログイン] ID=admin / PW=admin1234
echo [従業員ログイン] 社員ID（3桁）/ PIN（3桁・管理者が設定）
echo 停止するには Ctrl+C を押してください
echo.
uvicorn backend.main:app --host 0.0.0.0 --port 8002 --reload
pause
