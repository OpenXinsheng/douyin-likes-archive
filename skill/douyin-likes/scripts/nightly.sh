#!/usr/bin/env bash
# 凌晨定时任务：续采点赞 → 重算统计 → 重新生成链接页
# 由 Windows 任务计划程序调用：wsl.exe -d Ubuntu -e /bin/bash /home/gapdo/douyin/scripts/nightly.sh
set -uo pipefail

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$SELF_DIR" || exit 1

# 无图形会话下也要能跑：所有路径写死，不依赖登录 shell 的环境
export HOME="$SELF_DIR/.chome"
export XDG_DATA_HOME="$HOME/.local/share"
export XDG_RUNTIME_DIR=/mnt/wslg/runtime-dir
export WAYLAND_DISPLAY=wayland-0
export LD_LIBRARY_PATH="$SELF_DIR/vendor/libs/usr/lib/x86_64-linux-gnu"
export PLAYWRIGHT_BROWSERS_PATH="$SELF_DIR/browsers"

# 计划任务的 shell 不是登录 shell，PATH 很短，必须显式补上
export PATH="/home/gapdo/.local/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
NODE=$(command -v node || echo /usr/bin/node)
PYTHON=$(command -v python3 || echo /usr/bin/python3)
MAX_PAGES=${1:-3000}
DELAY_MS=${2:-2500}
TIMEOUT_S=${TIMEOUT_S:-18000}

mkdir -p logs
LOG="logs/nightly-$(date +%Y%m%d-%H%M%S).log"

{
  echo "=========================================="
  echo "开始: $(date '+%Y-%m-%d %H:%M:%S')"
  for i in $(seq 1 30); do
  [ -S "$XDG_RUNTIME_DIR/$WAYLAND_DISPLAY" ] && break
  sleep 1
done
echo "WSLg socket: $([ -S "$XDG_RUNTIME_DIR/$WAYLAND_DISPLAY" ] && echo 存在 || echo 缺失)"
echo "内存上限: $(free -g | awk '/Mem:/{print $2}') GB"
  echo "已采集: $(wc -l < .scratch/likes-all.jsonl 2>/dev/null || echo 0) 条"
  echo "node: $NODE ($($NODE -v 2>&1)) | 上限 ${MAX_PAGES} 页 | 每页延迟 ${DELAY_MS}ms | 超时 ${TIMEOUT_S}s"

  # 1) 续采（遇验证码会自动停下）
  timeout "$TIMEOUT_S" "$NODE" scripts/collect_all.mjs "$MAX_PAGES" "$DELAY_MS"
  echo "--- collect 退出码: $?"

  # 2) 重算统计 + 刷新链接页（即使采集失败也更新已有数据）
  "$PYTHON" scripts/stats_by_year.py
  "$PYTHON" scripts/make_links_page.py

  echo "结束: $(date '+%Y-%m-%d %H:%M:%S')"
  echo "最终: $(wc -l < .scratch/likes-all.jsonl 2>/dev/null || echo 0) 条"
} >> "$LOG" 2>&1

# 只保留最近 30 份日志
ls -1t logs/nightly-*.log 2>/dev/null | tail -n +31 | xargs -r rm -f
