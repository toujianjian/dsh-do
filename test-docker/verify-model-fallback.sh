#!/usr/bin/env bash
# 模型自动切换（modelFallback）验收：对照实验。
#
#   对照组：不打开 modelFallback —— 主模型 429，退避重试耗尽后应当**报错收场**
#   实验组：打开 modelFallback，候选 deepseek-official/deepseek-v4-pro —— 应当**切过去并成功应答**
#
# 两组共用同一个 mock（主模型一律 429、其它模型 200），唯一变量就是开关。
# 所以"实验组成立而对照组失败"才真正证明是 fallback 在起作用。
#
# 顺带验设计里的顺序：官方 dsh-llm-retry 先退避重试（默认 maxRetries=5、
# 初始 500ms 指数退避 ≈ 15.5s），只有它放弃后才轮到 dsh-do 切换。
set -uo pipefail
export DSH_HOME=/root/.dsh
export DEEPSEEK_API_KEY=dummy-mock-key

run_once() {
  local tag="$1" patch="$2" wait_s="$3"
  local RAW=/tmp/fb-$tag.raw CLEAN=/tmp/fb-$tag.txt FIFO=/tmp/fb-$tag.in MLOG=/tmp/fb-$tag.jsonl
  rm -f "$FIFO" "$RAW" "$MLOG"

  MOCK_LOG="$MLOG" node /root/mock-llm-fallback.mjs > /tmp/fb-$tag.mock.out 2>&1 &
  local MOCK=$!
  local HEALTH=""
  for _ in $(seq 1 25); do
    HEALTH=$(node -e "fetch('http://127.0.0.1:8899/health').then(r=>console.log(r.status)).catch(()=>console.log(''))" 2>/dev/null)
    [ "$HEALTH" = "200" ] && break
    sleep 0.3
  done

  mkfifo "$FIFO"
  (
    sleep 26
    printf '请用一句话说明你现在是哪个模型。\r'
    sleep "$wait_s"
    printf '\x03'
    sleep 2
  ) > "$FIFO" 2>/dev/null &
  local FEEDER=$!

  cd /root
  TERM=xterm-256color timeout $((26 + wait_s + 20)) script -q -c "stty rows 50 cols 130 2>/dev/null; dsh --profile tui --patch $patch" "$RAW" < "$FIFO" > /dev/null 2>&1
  local EXIT=$?
  wait $FEEDER 2>/dev/null
  kill $FEEDER 2>/dev/null
  sleep 1
  kill $MOCK 2>/dev/null

  sed -r 's/\x1B\[[0-9;?]*[a-zA-Z]//g; s/\x1B\][^\x07]*\x07//g; s/\x1B[()][A-Z0-9]//g; s/\x1B[>=]//g' "$RAW" | tr '\r' '\n' | grep -v '^[[:space:]]*$' > "$CLEAN"

  echo "----- [$tag] pty exit=$EXIT（124=超时收割），clean lines=$(wc -l < "$CLEAN") -----"
  echo "### mock 请求序列"
  cat "$MLOG" 2>/dev/null || echo "(空)"
  echo "### 429 次数=$(grep -c '\"status\":429' "$MLOG" 2>/dev/null || echo 0) / 200 次数=$(grep -c '\"status\":200' "$MLOG" 2>/dev/null || echo 0)"
  echo "### 界面里自报模型的回复（谁最终答的）"
  grep -n '我是 ' "$CLEAN" | head -5 || echo "(无)"
  echo "### dsh-do 自己的日志行"
  grep -n 'dsh-do:' "$CLEAN" | head -5 || echo "(界面未回显，属正常)"
  echo "### 报错/限流相关"
  grep -n -i 'rate limit\|RATE_LIMIT\|error\|失败' "$CLEAN" | head -8 || echo "(无)"
  echo
}

echo "############ 对照组：modelFallback 关闭 ############"
run_once control /root/mock-patch.yml 40
echo "############ 实验组：modelFallback 打开 ############"
run_once fallback /root/mock-fallback-patch.yml 55
echo "############ done ############"
