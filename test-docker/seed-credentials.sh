#!/usr/bin/env bash
# 管理容器里的 $DSH_HOME/.credentials.yaml。
#
#   bash seed-credentials.sh        # 写一个哑元凭证（适用于 dsh >= 0.1.5-rc.3）
#   bash seed-credentials.sh clear  # 删除凭证文件（适用于 dsh <= 0.1.0-rc.8）
#
# 为什么要分两种：
#   * dsh 0.1.2-rc.x 起的 TUI 首次运行会弹「设置 DeepSeek API Key」引导，把后续所有
#     按键都吃进 Key 输入框，/loop 与 /status 根本到不了界面 → 必须预置一个凭证跳过。
#   * 但凭证格式跨版本变过：0.1.0-rc.8 要求 `version` 是**字符串**，写数字会让
#     dsh-credentials-local 直接抛 TypeError 把整个 profile 启动打掉；
#     0.1.5-rc.3 起自己写的正是数字 `version: 1`。
#   * 0.1.0-rc.8 时代的 TUI 没有引导弹窗，没有凭证文件也能正常进主界面，所以直接清掉最省事。
#
# 本容器不做任何真实模型调用：/loop 起跑后必然因凭证无效而失败并暂停，而这正是要观测的
# 对象——暂停原因要能显示在 /status 的「◆ 循环」段上。
set -uo pipefail
F=/root/.dsh/.credentials.yaml

if [ "${1:-seed}" = "clear" ]; then
  rm -f "$F"
  echo "cleared $F (dsh <= 0.1.0-rc.8: the TUI onboards without it, and its format wants a string version)"
  exit 0
fi

mkdir -p "$(dirname "$F")"
printf 'version: 1\nrefs:\n  DEEPSEEK_API_KEY: dummy-key-for-tui-verification\n' > "$F"
chmod 600 "$F"
echo "wrote $F:"
od -c "$F"
