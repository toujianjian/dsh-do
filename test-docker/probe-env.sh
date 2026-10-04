#!/usr/bin/env bash
# 容器环境探针：每个 profile 的版本组合、dsh-do 产物身份、凭证现状。
# 用法：docker cp probe-env.sh dsh-env:/root/ && docker exec dsh-env bash /root/probe-env.sh
set -uo pipefail
export DSH_HOME=/root/.dsh

echo "global dsh: $(dsh --version 2>&1 | tail -1)"
echo "node: $(node -v)  pnpm: $(pnpm --version)"

for p in tui v010 v015 v017 v020 v020w web020; do
  DIR="$DSH_HOME/profiles/$p"
  [ -d "$DIR" ] || continue
  echo
  echo "--- $p ---"
  PROFILE_DIR="$DIR" node -e "
const fs=require('fs'),c=require('crypto');
const dir=process.env.PROFILE_DIR;
const read=(p)=>{try{return JSON.parse(fs.readFileSync(dir+'/node_modules/'+p+'/package.json','utf8')).version}catch(e){return '-'}};
console.log('  dsh-base :', read('@deepseek-ai/dsh-base'));
console.log('  tui      :', read('@huiliyi37/dsh-tianshu-tui'));
console.log('  dsh-do   :', read('dsh-do'));
const f=dir+'/node_modules/dsh-do/lib/index.js';
if(fs.existsSync(f))console.log('  dsh-do sha:', c.createHash('sha256').update(fs.readFileSync(f)).digest('hex').toUpperCase().slice(0,16));
const pj=dir+'/package.json';
if(fs.existsSync(pj)){const j=JSON.parse(fs.readFileSync(pj,'utf8'));console.log('  bundles  :', JSON.stringify(j.dsh&&j.dsh.profile&&j.dsh.profile.bundles));}
"
done

echo
echo "--- 凭证 ---"
ls -la /root/.dsh/ 2>/dev/null | head -20
echo "credentials file:"
for f in /root/.dsh/.credentials.yaml /root/.dsh/credentials.yaml /root/.dsh/.credentials.yml; do
  [ -f "$f" ] && echo "  FOUND $f" && head -c 400 "$f" && echo
done
echo "--- TUI 补丁状态（tui profile）---"
grep -c 'projectLoopSection' /root/.dsh/profiles/tui/node_modules/@huiliyi37/dsh-tianshu-tui/lib/index.js 2>/dev/null || echo "(no tui bundle)"
