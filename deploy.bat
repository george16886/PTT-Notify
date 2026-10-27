@echo off
rem 部署：待推送的 commit 若有改到 src\，先 clasp push 到 Apps Script，再 git push。
rem 用法：雙擊執行，或 deploy.bat [git push 參數]，或 npm run deploy
setlocal
for /f "tokens=2 delims=:" %%a in ('chcp') do set /a OLDCP=%%a
chcp 65001 >nul
cd /d "%~dp0"
set EXITCODE=0

rem src\ 有未 commit 的修改就中止，確保 Apps Script 與 GitHub 是同一份程式
for /f %%i in ('git status --porcelain -- src') do (
  echo [X] src\ 有尚未 commit 的修改，請先 commit 再部署。
  goto :fail
)

rem 沒有 upstream（第一次推送）視為有變動
set SRC_CHANGED=1
git rev-parse --abbrev-ref --symbolic-full-name @{u} >nul 2>&1
if not errorlevel 1 (
  git diff --quiet @{u} HEAD -- src
  if not errorlevel 1 set SRC_CHANGED=0
)

if "%SRC_CHANGED%"=="1" (
  echo ^> src\ 有變動，推送到 Apps Script...
  call npm run push || goto :fail
) else (
  echo ^> src\ 沒有變動，略過 clasp push
)

echo ^> git push
git push %* || goto :fail
echo [OK] 完成
goto :end

:fail
set EXITCODE=1

:end
chcp %OLDCP% >nul
rem 雙擊執行時暫停，讓視窗不會馬上關掉（從 npm 或已開啟的命令列執行則不暫停）
setlocal EnableDelayedExpansion
set "CL=!cmdcmdline!"
if not defined npm_lifecycle_event if /i not "!CL:/c=!"=="!CL!" pause
exit /b %EXITCODE%
