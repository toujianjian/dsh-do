#!/usr/bin/env bash
# 逐帧解码会话日志（文件里是多个独立 zstd 帧，Node 的单次解压只看第一帧）。
set -uo pipefail
S=${1:-/root/.dsh/sessions/--root--/session-9a6c3627-774e-422b-878a-4fccdf32619a/session.jsonl.zstd}

node -e '
const fs=require("fs"), z=require("zlib");
const b=fs.readFileSync(process.argv[1]);
const magic=Buffer.from([0x28,0xb5,0x2f,0xfd]);
const offs=[]; let i=0;
while((i=b.indexOf(magic,i))!==-1){ offs.push(i); i+=4 }
let out="";
offs.forEach((start,idx)=>{
  const end = idx+1<offs.length ? offs[idx+1] : b.length;
  try { out += z.zstdDecompressSync(b.subarray(start,end)).toString() }
  catch(e){ out += `\n[frame ${idx} @${start} decode error: ${e.message}]\n` }
});
console.log("frames:", offs.length, "decoded bytes:", out.length);
const lines=out.split("\n").filter(Boolean);
console.log("lines:", lines.length);
console.log();
for(const l of lines){
  let e; try{e=JSON.parse(l)}catch{ console.log("(unparsed)", l.slice(0,100)); continue }
  const t=e.type??"?";
  const d=e.data??{};
  const bits=[t];
  if(e.seq!==undefined) bits.push("seq="+e.seq);
  if(e.ts!==undefined) bits.push("ts="+e.ts);
  if(e.at!==undefined) bits.push("at="+e.at);
  if(d.source) bits.push("source="+JSON.stringify(d.source));
  if(d.reason) bits.push("reason="+JSON.stringify(d.reason).slice(0,150));
  if(d.error) bits.push("error="+JSON.stringify(d.error).slice(0,240));
  if(d.message&&typeof d.message==="object") bits.push("msg="+JSON.stringify(d.message).slice(0,200));
  if(typeof d.text==="string") bits.push("text="+JSON.stringify(d.text).slice(0,150));
  if(d.loopId) bits.push("loopId="+d.loopId);
  console.log(bits.join("  "));
}
' "$S" 2>&1 | head -90
