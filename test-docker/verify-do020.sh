#!/usr/bin/env bash
# 验证 0.2.0 适配：dsh-do 的段现在以什么 ns 出现、内容是否是完整配置。
set -uo pipefail
export DSH_HOME=/root/.dsh
PORT=3199
LOG=/tmp/do020.log
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
(async()=>{
  const a=await req("/?token="+TOKEN);
  const cookie=(a.headers["set-cookie"]||[]).map(c=>c.split(";")[0]).join("; ");

  const d=await req("/dsh-do/settings", {cookie});
  const j=JSON.parse(d.body);
  console.log("=== GET /dsh-do/settings ===");
  console.log("status "+d.status+", "+d.body.length+" bytes");
  console.log("sections: "+j.sections.map(s=>s.ns).join(", "));
  const doSec=j.sections.find(s=>s.value && typeof s.value==="object" && "loopDetection" in s.value);
  console.log("");
  console.log("=== dsh-do 段 ===");
  if(doSec){
    console.log("ns = "+JSON.stringify(doSec.ns)+"   revision = "+doSec.revision);
    console.log("value = "+JSON.stringify(doSec.value));
    console.log("user  = "+JSON.stringify(doSec.user));
  } else { console.log("(未找到)"); }

  // 真实写入：改 defaultMaxRounds，看是否被接受并回读。
  if(doSec){
    const body=JSON.stringify({ns:doSec.ns, ops:[{op:"set", path:["defaultMaxRounds"], value:7}], expectedRevision:doSec.revision});
    const w=await new Promise((res,rej)=>{
      const r=http.request({host:"127.0.0.1",port:PORT,path:"/dsh-do/settings",method:"POST",
        headers:{host:"127.0.0.1:"+PORT, cookie, "content-type":"application/json", "content-length":Buffer.byteLength(body)}},
        x=>{let b="";x.on("data",d=>b+=d);x.on("end",()=>res({status:x.statusCode,body:b}))});
      r.on("error",rej); r.write(body); r.end();
    });
    console.log("");
    console.log("=== POST 写入 defaultMaxRounds=7 ===");
    console.log("status "+w.status);
    console.log("body: "+w.body.slice(0,400));
    if(w.status===200){
      const after=JSON.parse(w.body);
      const sec=after.sections.find(s=>s.value && typeof s.value==="object" && "loopDetection" in s.value);
      console.log("回读 defaultMaxRounds = "+JSON.stringify(sec && sec.value.defaultMaxRounds));
      console.log("回读 revision = "+JSON.stringify(sec && sec.revision));
      console.log("回读 user = "+JSON.stringify(sec && sec.user));
    }
  }
})().catch(e=>console.log("PROBE ERROR: "+e.message));
'
kill "$SRV" 2>/dev/null; wait "$SRV" 2>/dev/null
echo "############ done ############"
