#!/bin/zsh -l
cd "${0:A:h}" || exit 1
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
if ! command -v node >/dev/null; then
  print '未找到 Node.js，请先安装 Node.js 22.13 或更新版本。'
  read '?按回车关闭窗口…'
  exit 1
fi
node scripts/launch.mjs
result=$?
if (( result != 0 )); then
  read '?启动未完成，请查看上方提示。按回车关闭窗口…'
fi
exit $result
