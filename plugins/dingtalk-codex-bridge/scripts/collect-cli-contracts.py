#!/usr/bin/env python3
"""Collect static Schema and Help only. Never execute business handlers."""
import argparse, concurrent.futures, json, os, re, subprocess
from pathlib import Path

p=argparse.ArgumentParser();p.add_argument('--cli',required=True);p.add_argument('--output',required=True);a=p.parse_args()
out=Path(a.output);out.mkdir(parents=True,exist_ok=True);env=dict(os.environ,DWS_NO_UPDATE_CHECK='1')
with (out/'schemas-all.json').open('w') as f:subprocess.run([a.cli,'schema','--all','--format','json'],stdout=f,check=True,timeout=90,env=env)
schema=json.loads((out/'schemas-all.json').read_text());tools=[t for p in schema['products'] for t in p['tools']]
def help_for(command):
 r=subprocess.run([a.cli,*command.split(),'--help'],capture_output=True,text=True,timeout=20,env=env);variant='--help'
 if r.returncode:
  short=subprocess.run([a.cli,*command.split(),'-h'],capture_output=True,text=True,timeout=20,env=env)
  if not short.returncode:r=short;variant='-h'
 text=r.stdout+r.stderr;flags={};local=True
 for line in text.splitlines():
  if line.startswith('Global Flags:'):local=False
  m=re.match(r'^\s+(?:-\w,\s+)?--([\w-]+)(?:\s+([A-Za-z][\w\[\]]*))?\s{2,}',line)
  if m:flags[m[1]]={'kind':m[2] or 'bool','local':local}
 return command,{'exit':r.returncode,'flags':flags,'usage':[],'help':text,'help_variant':variant}
contracts={}
with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
 for i,(command,result) in enumerate(pool.map(help_for,[t['cli_path'] for t in tools]),1):
  contracts[command]=result
  if i%250==0:print(f'Help contracts {i}/{len(tools)}',flush=True)
(out/'all-contracts.json').write_text(json.dumps(contracts,ensure_ascii=False,indent=2))
utilities={};pending=['auth','config','profile','plugin','upgrade','doctor','completion','cache','recovery','api','skill','schema','version']
while pending:
 command=pending.pop(0);_,result=help_for(command);children=[];block=False
 for line in result['help'].splitlines():
  if line.strip()=='Available Commands:':block=True;continue
  if block and re.match(r'^\S',line):block=False
  m=re.match(r'^  ([a-z][a-z0-9-]*)\s{2,}',line) if block else None
  if m and m[1]!='help':children.append(command+' '+m[1])
 result.update(path=command,children=children);utilities[command]=result
 pending.extend(c for c in children if c not in utilities)
(out/'utility-help.json').write_text(json.dumps(utilities,ensure_ascii=False,indent=2))
print(json.dumps({'schema_commands':len(tools),'utility_leaves':sum(not u['children'] for u in utilities.values()),'business_calls':0}))
