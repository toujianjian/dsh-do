#!/usr/bin/env bash
# 对照实验：对**平台自带**的段（agent-default-model）做一次同值写入。
# 若同样报 "root Include entry"，说明这是 0.2.0 profile-patch 写入路径的平台级问题，
# 不是 dsh-do 的缺陷。
set -uo pipefail
export DSH_HOME=/root/.dsh
PORT=3199
LOG=/tmp/ctrl020.log
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
function req(path, opts){
  return new Promise((res,rej)=>{
    const r=http.request(Object.assign({host:"127.0.0.1",port:PORT,path,method:"GET",
      headers:{host:"127.0.0.1:"+PORT}}, opts||{}), x=>{
      let b="";x.on("data",d=>b+=d);x.on("end",()=>res({status:x.statusCode,headers:x.headers,body:b}));
    });
    r.on("error",rej); r.end();
  });
}
function post(path, cookie, payload){
  const body=JSON.stringify(payload);
  return new Promise((res,rej)=>{
    const r=http.request({host:"127.0.0.1",port:PORT,path,method:"POST",
      headers:{host:"127.0.0.1:"+PORT, cookie, "content-type":"application/json", "content-length":Buffer.byteLength(body)}},
      x=>{let b="";x.on("data",d=>b+=d);x.on("end",()=>res({status:x.statusCode,body:b}))});
    r.on("error",rej); r.write(body); r.end();
  });
}
(async()=>{
  const a=await req("/?token="+TOKEN);
  const cookie=(a.headers["set-cookie"]||[]).map(c=>c.split(";")[0]).join("; ");
  const d=await req("/dsh-do/settings", {cookie});
  const j=JSON.parse(d.body);
  console.log("served sections: "+j.sections.map(s=>s.ns).join(", "));
  console.log("");

  const adm=j.sections.find(s=>s.ns==="agent-default-model");
  console.log("=== 对照：写入平台自带段 agent-default-model（同值）===");
  console.log("当前 value = "+JSON.stringify(adm.value)+"  revision = "+adm.revision);
  const w1=await post("/dsh-do/settings", cookie, {
    ns:"agent-default-model",
    ops:[{op:"set", path:["model"], value:adm.value.model}],
    expectedRevision:adm.revision,
  });
  console.log("status "+w1.status);
  console.log("body: "+w1.body.slice(0,300));
  console.log("");

  const doSec=j.sections.find(s=>s.value && typeof s.value==="object" && "loopDetection" in s.value);
  console.log("=== 被测：写入 dsh-do 段（defaultMaxRounds 20 -> 同值 20）===");
  const w2=await post("/dsh-do/settings", cookie, {
    ns:doSec.ns,
    ops:[{op:"set", path:["defaultMaxRounds"], value:20}],
    expectedRevision:doSec.revision,
  });
  console.log("status "+w2.status);
  console.log("body: "+w2.body.slice(0,300));
})().catch(e=>console.log("PROBE ERROR: "+e.message));
'
kill "$SRV" 2>/dev/null; wait "$SRV" 2>/dev/null
echo "############ done ############"
