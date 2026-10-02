#!/usr/bin/env bash
# 决定性探测：dsh web 在 0.2.0-rc.2 下吐出的 HTML 壳里，到底有没有 dsh-do 的客户端产物。
#
#   bash /root/probe-shell.sh <profile> [port]
#
# 0.2.0 的 web 端有 token 鉴权：GET /?token=… 会 303 并种 cookie，之后的请求要带 cookie。
# 客户端插件产物走 @deepseek-ai/dsh-client-modules 的组合模块系统，URL 形如
# /plugins/??<id>/client.js,<id2>/client.js&rev=<rev>，单件地址是 /plugins/<id>/client.js。
set -uo pipefail
export DSH_HOME=/root/.dsh
PROFILE="${1:?usage: probe-shell.sh <profile> [port]}"
PORT="${2:-3199}"
LOG="/tmp/shell-$PROFILE.log"

dsh --profile "$PROFILE" --port "$PORT" --no-open --host 127.0.0.1 > "$LOG" 2>&1 &
SRV=$!
for i in $(seq 1 90); do
  node -e "require('net').connect($PORT,'127.0.0.1').on('connect',()=>process.exit(0)).on('error',()=>process.exit(1))" 2>/dev/null && break
  kill -0 "$SRV" 2>/dev/null || { echo "!! server exited early"; break; }
  sleep 1
done

TOKEN="$(grep -o 'token=[A-Za-z0-9._-]*' "$LOG" | head -1 | cut -d= -f2)"
echo "token: ${TOKEN:-(未打印)}"

PROBE_PORT="$PORT" PROBE_TOKEN="$TOKEN" node -e '
const http=require("http");
const PORT=Number(process.env.PROBE_PORT), TOKEN=process.env.PROBE_TOKEN;
function get(path, headers){
  return new Promise((res,rej)=>{
    const req=http.request({host:"127.0.0.1",port:PORT,path,method:"GET",
      headers:Object.assign({host:"127.0.0.1:"+PORT}, headers||{})},r=>{
      let b="";r.on("data",d=>b+=d);r.on("end",()=>res({status:r.statusCode,headers:r.headers,body:b}));
    });
    req.on("error",rej); req.end();
  });
}
(async()=>{
  const a=await get("/?token="+TOKEN);
  const setc=a.headers["set-cookie"]||[];
  console.log("GET /?token=… -> "+a.status+"  location="+(a.headers.location||"(none)"));
  console.log("  set-cookie: "+(setc.length?setc.map(c=>c.split(";")[0]).join(" ; "):"(none)"));
  const cookie=setc.map(c=>c.split(";")[0]).join("; ");

  const b=await get("/", {cookie});
  console.log("GET / (with cookie) -> "+b.status+"  "+b.body.length+" bytes");
  const urls=[...new Set((b.body.match(/\/plugins\/[^"'"'"'\s<>)]*/g)||[]))];
  console.log("  /plugins 引用数: "+urls.length);
  urls.slice(0,12).forEach(u=>console.log("    "+u));
  console.log("  HTML 里提到 dsh-do: "+b.body.includes("dsh-do"));

  const c=await get("/plugins/dsh-do/client.js", {cookie});
  console.log("GET /plugins/dsh-do/client.js -> "+c.status+"  "+c.body.length+" bytes");
  if(c.status===200){
    const marks=["断连重试策略","模型循环检测","DoSettingsPage","/dsh-do/settings","settings.section"];
    console.log("  markers: "+marks.filter(m=>c.body.includes(m)).join(", "));
  }

  const d=await get("/dsh-do/settings", {cookie, accept:"application/json"});
  console.log("GET /dsh-do/settings (accept json) -> "+d.status+"  "+d.body.length+" bytes");
  console.log("  head: "+d.body.slice(0,220).replace(/\s+/g," "));
})().catch(e=>console.log("PROBE ERROR: "+e.message));
'

kill "$SRV" 2>/dev/null
wait "$SRV" 2>/dev/null
echo "############ done ############"
