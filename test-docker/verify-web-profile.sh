#!/usr/bin/env bash
# 起一个 web profile 的服务器，验证 Web 半（而不是 TUI 半）的适配情况。
#
#   bash /root/verify-web-profile.sh <profile> [port]
#
# 验的是 TUI 侧验不到的四件事：
#   ① 进程能否带着 dsh-do 干净启动（插件装载失败会在这里现形）
#   ② GET / 是否 200
#   ③ GET /plugins/dsh-do/client.js 是否出厂，且含新客户端标记
#   ④ /dsh-do/settings 路由是否就位（Web 专属，TUI 下由 ctx.inject 门控跳过）
#
# 注意 dsh 0.2.x 的 web 端有 token 鉴权（/ 直接返回 401），日志里会打印
# `http://host:port/?token=…`；所有探测都必须带上它，否则 404/401 都是噪音。
set -uo pipefail
export DSH_HOME=/root/.dsh
PROFILE="${1:?usage: verify-web-profile.sh <profile> [port]}"
PORT="${2:-3199}"
LOG="/tmp/web-$PROFILE.log"

echo "############ Web verify: profile=$PROFILE port=$PORT ############"

dsh --profile "$PROFILE" --port "$PORT" --no-open --host 127.0.0.1 > "$LOG" 2>&1 &
SRV=$!
echo "server pid=$SRV"

for i in $(seq 1 90); do
  if node -e "require('net').connect($PORT,'127.0.0.1').on('connect',()=>process.exit(0)).on('error',()=>process.exit(1))" 2>/dev/null; then
    echo "port ready after ${i}s"
    break
  fi
  if ! kill -0 "$SRV" 2>/dev/null; then
    echo "!! server exited early (see log)"
    break
  fi
  sleep 1
done

TOKEN="$(grep -o 'token=[A-Za-z0-9._-]*' "$LOG" | head -1 | cut -d= -f2)"
echo "token: ${TOKEN:-(未打印)}"

probe() {
  PROBE_PATH="$1" PROBE_TOKEN="$TOKEN" PROBE_PORT="$PORT" node -e "
const http=require('http');
const p=process.env.PROBE_PATH;
const sep=p.includes('?')?'&':'?';
const url=process.env.PROBE_TOKEN? p+sep+'token='+process.env.PROBE_TOKEN : p;
const req=http.request({host:'127.0.0.1',port:Number(process.env.PROBE_PORT),path:url,method:'GET',
  headers:{host:'127.0.0.1:'+process.env.PROBE_PORT}},res=>{
  let b='';res.on('data',d=>b+=d);res.on('end',()=>{
    console.log(p+' -> HTTP '+res.statusCode+'  '+b.length+' bytes');
    const marks=['断连重试策略','模型循环检测','DoSettingsPage','/dsh-do/settings','settings.section'];
    const hit=marks.filter(m=>b.includes(m));
    if(hit.length) console.log('   markers: '+hit.join(', '));
    if(res.statusCode>=400 || b.length<400) console.log('   body head: '+b.slice(0,260).replace(/\s+/g,' '));
  });
});
req.on('error',e=>console.log(p+' -> ERROR '+e.message));
req.end();
"
}

echo
echo "=== HTTP 探测 ==="
probe /
probe /plugins/dsh-do/client.js
probe /dsh-do/settings

echo
echo "=== 启动期错误 ==="
if grep -n 'Error\|failed to load\|did not activate\|TypeError\|not a function' "$LOG" | head -25; then :; else echo "(无)"; fi

echo
echo "=== 日志尾部 ==="
tail -12 "$LOG"

kill "$SRV" 2>/dev/null
wait "$SRV" 2>/dev/null
echo "############ done: $PROFILE ############"
