@echo off
echo ===================================
echo  AI 모의면접 시스템 시작
echo ===================================

echo [1/2] 백엔드 서버 시작 (포트 8002)...
cd /d "%~dp0interview-ai\backend"
start "Backend" python -m uvicorn app.main:app --host 127.0.0.1 --port 8002

echo 백엔드 초기화 대기 (5초)...
timeout /t 5 /nobreak >nul

echo [2/2] 프론트엔드 시작 (포트 3000)...
cd /d "%~dp0interview-ai\frontend"
start "Frontend" npm run dev

echo.
echo ===================================
echo  서버 시작 완료!
echo  - 프론트엔드: http://localhost:3000
echo  - API 문서:   http://localhost:8002/docs
echo ===================================
echo 창을 닫으면 서버가 종료됩니다.
pause
