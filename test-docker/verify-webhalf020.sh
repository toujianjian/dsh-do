#!/usr/bin/env bash
# 验证 0.2.0 上 Web 半的其余部分：
#   ① 客户端产物经组合 URL 真实可取，且含本轮新标记
#   ② /do-config 通过 0.2.0 的 describe/mutate 形状读到 dsh-do 设置
set -uo pipefail
export DSH_HOME=/root/.dsh
PORT=3199
LOG=/tmp/web020half.log
dsh --profile web020 --port $PORT --no-open --host 127.0.0.1 > "$LOG" 2>&1 &
SRV=$!
for i in $(seq 1 90); do
  node -e "require('net').connect($PORT,'127.0.0.1').on('connect',()=>process.exit(0)).on('error',()=>process.exit(1))" 2>/dev/null && break
  kill -0 "$SRV" 2>/dev/null || { echo "!! 提前退出"; break; }
  sleep 1
done
TOKEN="$(grep -o 'token=[A-Za-z0-9._-]*' "$LOG" | head -1 | cut -d= -f2)"

PROBE_PORT=$PORT PROBE_TOKEN="$TOKEN" node -e '
const http=require("http");
const PORT=Number(process.env.PROBE_PORT), TOKEN=process.env.PROBE_TOKEN;
function get(path, headers){
  return new Promise((res,rej)=>{
    const r=http.request({host:"127.0.0.1",port:PORT,path,method:"GET",
      headers:Object.assign({host:"127.0.0.1:"+PORT}, headers||{})}, x=>{
      let b="";x.on("data",d=>b+=d);x.on("end",()=>res({status:x.statusCode,headers:x.headers,body:b}));
    });
    r.on("error",rej); r.end();
  });
}
(async()=>{
  const a=await get("/?token="+TOKEN);
  const cookie=(a.headers["set-cookie"]||[]).map(c=>c.split(";")[0]).join("; ");
  const html=(await get("/", {cookie})).body;

  // 从壳的模块清单里取 dsh-do 的真实组合 URL。
  const m=html.match(/"id":"dsh-do","url":"([^"]+)"/);
  console.log("=== ① 客户端产物 ===");
  console.log("清单里的 url: "+(m?m[1]:"(未找到)"));
  if(m){
    const rel=m[1].replace(/&amp;/g,"&");
    const path=rel.startsWith("/")?rel:"/"+rel;
    const c=await get(path, {cookie});
    console.log("GET "+path.slice(0,70)+"… -> "+c.status+"  "+c.body.length+" bytes");
    const marks=["断连重试策略","模型循环检测","DoSettingsPage","/dsh-do/settings","settings.section","resolveDoNamespace","dsh-do"];
    console.log("markers: "+marks.filter(k=>c.body.includes(k)).join(", "));
  }

  console.log("");
  console.log("=== ② 壳里 dsh-do 的 inject 声明 ===");
  const inj=html.match(/\{"id":"dsh-do","url":"[^"]+","rev":"[^"]+","inject":\[[^\]]*\]\}/);
  console.log(inj?inj[0]:"(未找到)");
})().catch(e=>console.log("PROBE ERROR: "+e.message));
'
kill "$SRV" 2>/dev/null; wait "$SRV" 2>/dev/null
echo "############ done ############"
