#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
RUN="$ROOT/.run"
PID_FILE="$RUN/app.pid"
LOCK="$RUN/app.lock"
LOG="$ROOT/logs/app.log"

fail() { printf '%s\n' "$*" >&2; exit 1; }

# Compare both birth time and command, never trust a recycled PID alone.
identity() {
  ps -p "$1" -o lstart= -o command= 2>/dev/null || true
}

is_running() {
  [[ -f "$PID_FILE" && -f "$RUN/identity" ]] || return 1
  PID="$(< "$PID_FILE")"
  [[ "$PID" =~ ^[0-9]+$ && "$PID" -gt 1 ]] || return 1
  kill -0 "$PID" 2>/dev/null || return 1
  [[ "$(ps -p "$PID" -o stat= 2>/dev/null)" != *Z* ]] || return 1
  [[ "$(identity "$PID")" == "$(< "$RUN/identity")" ]]
}

port_value() {
  PORT="${PORT:-$(if [[ -f "$RUN/port" ]]; then printf '%s' "$(< "$RUN/port")"; else printf '3000'; fi)}"
  [[ "$PORT" =~ ^[0-9]+$ && ${#PORT} -le 5 ]] || fail 'PORT 必须是 1–65535 的整数。'
  PORT="$((10#$PORT))"
  (( PORT >= 1 && PORT <= 65535 )) || fail 'PORT 必须是 1–65535 的整数。'
}

start_app() {
  if is_running; then
    printf '服务已运行，PID=%s。\n' "$PID"
    return
  fi
  command -v node >/dev/null || fail '未找到 Node.js，请先安装 Node.js 20 或更新版本。'
  port_value
  node --check "$ROOT/server.js"
  # Detect unmanaged foreground/nohup services without killing them.
  node - "$PORT" <<'NODE'
const net = require('node:net');
const port = Number(process.argv[2]);
const server = net.createServer();
server.on('error', error => {
  console.error(`端口 ${port} 不可用：${error.message}。请先停止原服务，脚本不会接管或终止它。`);
  process.exitCode = 1;
});
server.listen(port, '0.0.0.0', () => server.close());
NODE
  mkdir -p "$ROOT/logs"
  printf '\n--- %s start PORT=%s ---\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$PORT" >> "$LOG"
  (cd "$ROOT"; exec nohup env PORT="$PORT" node "$ROOT/server.js" >> "$LOG" 2>&1 < /dev/null) &
  PID=$!
  printf '%s\n' "$PID" > "$PID_FILE"
  # Wait until exec has replaced the shell before recording process identity.
  sleep 0.2
  if ! kill -0 "$PID" 2>/dev/null; then
    rm -f "$PID_FILE"
    fail "启动失败，请查看 $LOG"
  fi
  identity "$PID" > "$RUN/identity"
  printf '%s\n' "$PORT" > "$RUN/port"
  for ((attempt = 0; attempt < 40; attempt++)); do
    if ! is_running; then
      rm -f "$PID_FILE" "$RUN/identity"
      fail "启动失败，请查看 $LOG"
    fi
    if node - "$PORT" <<'NODE'
const http = require('node:http');
const request = http.get({ host: '127.0.0.1', port: Number(process.argv[2]), path: '/api/info', timeout: 500 }, response => {
  let body = '';
  response.on('data', chunk => { body += chunk; });
  response.on('end', () => {
    try { process.exit(response.statusCode === 200 && Array.isArray(JSON.parse(body).addresses) ? 0 : 1); }
    catch { process.exit(1); }
  });
});
request.on('timeout', () => request.destroy());
request.on('error', () => process.exit(1));
NODE
    then
      printf '启动成功，PID=%s，访问 http://localhost:%s\n日志：%s\n' "$PID" "$PORT" "$LOG"
      return
    fi
    sleep 0.2
  done
  stop_app
  fail "启动超时，已停止本次进程。请查看 $LOG"
}

stop_app() {
  if ! is_running; then
    rm -f "$PID_FILE" "$RUN/identity"
    printf '没有由 app.sh 管理的运行中服务。\n'
    return
  fi
  printf '正在停止服务，PID=%s…\n' "$PID"
  kill -TERM "$PID"
  for ((attempt = 0; attempt < 50; attempt++)); do
    if ! is_running; then
      rm -f "$PID_FILE" "$RUN/identity"
      printf '服务已停止。\n'
      return
    fi
    sleep 0.2
  done
  fail '进程未在 10 秒内退出，未强制杀进程。请检查后重试。'
}

main() {
  case "${1:-}" in start|stop|restart) ;; *) fail '用法：bash app.sh [start|stop|restart]' ;; esac
  mkdir -p "$RUN"
  mkdir "$LOCK" 2>/dev/null || fail "其他服务管理操作正在执行；若上次被强制中断，请确认后清理 $LOCK"
  trap 'rmdir "$LOCK" 2>/dev/null || true' EXIT
  case "$1" in
    start) start_app ;;
    stop) stop_app ;;
    restart) port_value; stop_app; start_app ;;
  esac
}
main "$@"
