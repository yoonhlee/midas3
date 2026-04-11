@echo off
chcp 65001 > nul
echo.
echo ====================================
echo    AI 면접 시뮬레이터 시작
echo ====================================
echo.

REM 백엔드 가상환경 설정
cd /d "%~dp0backend"
if not exist ".venv" (
    echo [1/4] Python 가상환경 생성 중...
    python -m venv .venv
)
echo [2/4] 패키지 설치 중...
call .venv\Scripts\activate.bat
pip install -r requirements.txt -q

echo [3/4] 백엔드 서버 시작 (포트 8000)...
start "FastAPI 백엔드" cmd /k "cd /d %~dp0backend && .venv\Scripts\activate && uvicorn main:app --reload --port 8000"

REM 프론트엔드
cd /d "%~dp0frontend"
echo [4/4] 프론트엔드 서버 시작 (포트 3000)...
timeout /t 3 /nobreak > nul
start "Next.js 프론트엔드" cmd /k "cd /d %~dp0frontend && npm run dev"

echo.
echo ====================================
echo 서버가 시작되었습니다!
echo  - 프론트엔드: http://localhost:3000
echo  - 백엔드 API: http://localhost:8000
echo  - API 문서:   http://localhost:8000/docs
echo ====================================
echo.
echo 브라우저에서 http://localhost:3000 을 열어주세요.
echo (백엔드가 완전히 시작될 때까지 10초 정도 기다려주세요)
echo.
timeout /t 5 /nobreak > nul
start http://localhost:3000
