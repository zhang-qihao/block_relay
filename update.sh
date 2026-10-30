#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
LOCK="$ROOT/.run/update.lock"
fail() { printf '%s\n' "$*" >&2; exit 1; }

main() {
  command -v git >/dev/null || fail '未找到 Git。'
  command -v npm >/dev/null || fail '未找到 npm。'
  cd "$ROOT"
  [[ "$(git rev-parse --show-toplevel)" == "$ROOT" ]] || fail '脚本必须位于独立项目 Git 仓库根目录。'
  mkdir -p "$ROOT/.run"
  mkdir "$LOCK" 2>/dev/null || fail "另一个更新正在执行；若上次被强制中断，请确认后清理 $LOCK"
  trap 'rmdir "$LOCK" 2>/dev/null || true' EXIT
  [[ -z "$(git status --porcelain --untracked-files=normal)" ]] || fail '工作区有未提交或未跟踪文件，已取消更新。请先提交或备份，不会自动覆盖。'
  git symbolic-ref -q HEAD >/dev/null || fail '当前为 detached HEAD，请先切换到本地分支。'
  git remote get-url origin >/dev/null
  printf '从 origin/master 获取更新…\n'
  git fetch origin refs/heads/master
  # Check ancestry first so a diverged branch never changes the checkout.
  git merge-base --is-ancestor HEAD FETCH_HEAD || fail '本地不是远端 master 的祖先，无法快进更新。请先人工处理本地提交。'
  git merge --ff-only FETCH_HEAD
  printf '安装锁定版本的运行依赖…\n'
  npm ci --omit=dev
  npm run check
  printf '代码与依赖检查通过，重启服务（当前房间会清空）…\n'
  bash "$ROOT/app.sh" restart
  printf '更新完成：%s\n' "$(git rev-parse --short HEAD)"
}
# Load this entire function before Git can replace the script on disk.
main "$@"
