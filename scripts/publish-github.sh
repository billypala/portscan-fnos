# 发布 portscan-fnos 到 GitHub
# 前置条件：gh 已登录（gh auth status 显示 Logged in）
# 用法：在仓库根目录执行  bash scripts/publish-github.sh

set -euo pipefail

GH="/c/Users/billy/WorkBuddy/飞牛应用开发/tools/gh/bin/gh.exe"
REPO="portscan-fnos"
OWNER="billypala"
DESC="Lightweight native TCP port scanner for fnOS / 飞牛 fnOS 原生端口扫描工具，零依赖、响应式、支持双击端口自定义备注"
TOPICS="fnos,nas,port-scanner,tcp-scanner,nodejs,network-tools,responsive"

cd "$(dirname "$0")/.."

echo "==> 检查 gh 登录状态"
if ! "$GH" auth status >/dev/null 2>&1; then
  echo "错误：gh 未登录。请先执行："
  echo "  \"$GH\" auth login"
  exit 1
fi
echo "    已登录"

echo "==> 确认工作区干净"
if [ -n "$(git status --porcelain)" ]; then
  echo "错误：存在未提交改动，请先 commit"
  git status --short
  exit 1
fi

echo "==> 创建仓库（若已存在则跳过）"
if "$GH" repo view "$OWNER/$REPO" >/dev/null 2>&1; then
  echo "    仓库已存在：$OWNER/$REPO"
else
  "$GH" repo create "$REPO" \
    --public \
    --source=. \
    --remote=origin \
    --description "$DESC" \
    --push
  echo "    仓库已创建并推送"
fi

echo "==> 设置仓库简介与标签"
# gh 的 StringSlice 参数接受逗号分隔列表
"$GH" repo edit "$OWNER/$REPO" \
  --description "$DESC" \
  --add-topic "$TOPICS"

echo "==> 确认远程与推送状态"
git remote get-url origin 2>/dev/null || true
git log --oneline -1
git status -sb | head -3

echo ""
echo "完成：https://github.com/$OWNER/$REPO"
