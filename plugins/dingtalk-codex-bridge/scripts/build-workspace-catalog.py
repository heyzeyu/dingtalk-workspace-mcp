#!/usr/bin/env python3
"""Build the reproducible pinned workspace catalogue from official local CLI exports."""
import argparse, json, re, csv
from pathlib import Path
from collections import Counter
p=argparse.ArgumentParser();p.add_argument('--schema',required=True);p.add_argument('--contracts',required=True);p.add_argument('--utilities',required=True);p.add_argument('--root',required=True);a=p.parse_args()
x=json.loads(Path(a.schema).read_text());contracts=json.loads(Path(a.contracts).read_text());utilities=json.loads(Path(a.utilities).read_text());root=Path(a.root)
keep={'description','type','required','enum','default','format','minimum','maximum','items','required_when','example'}
local_paths={'mcp url get','dev connect','dingtalk-tag connect','dingtalk-tag manage login'}
entries=[]
for product in x['products']:
 for t in product['tools']:
  command=t['cli_path'];contract=contracts[command]
  reason='Pinned public structured command';mode='mcp'
  if t['availability']!='available':mode='unavailable';reason='Official fixed-version Schema marks this command unavailable or retired'
  elif command=='mcp published invoke':mode='published_adapter';reason='Explicitly authorized published MCP invocation; native fresh Schema gate and exact service/tool identity'
  elif product['id']=='pat' or command in local_paths or re.search(r'\bcredential(?:s)?\b|\bdev mcp auth\b',command) or command.startswith('dingtalk-tag channel '):mode='local_workflow';reason='Credential, delegated authorization, dynamic executor or local Agent channel lifecycle; use the documented local CLI workflow'
  elif command in ['event consume','event +listen-im']:mode='event_adapter';reason='Bounded NDJSON event adapter with graceful shutdown and owned-subscription cleanup'
  elif 'stdin' in t['parameters'] and 'channel' in command:mode='local_workflow';reason='Local channel protocol requires a persistent Agent process'
  absent=sorted(set(t['parameters'])-set(contract['flags']))
  if absent and mode=='mcp':mode='contract_drift';reason='Schema flags missing from actual executable Help: '+','.join(absent)
  usage=[];in_usage=False
  for line in contract['help'].splitlines():
   if line.strip()=='Usage:':in_usage=True;continue
   if in_usage and line and not line[0].isspace():break
   if in_usage and line.strip().startswith('dws '):usage.append(line.strip()[4:])
  entries.append({'command':command,'product':product['id'],'description':t['description'],'effect':t['effect'],'risk':t['risk'],'confirmation':t['confirmation'],'idempotency':t['idempotency'],'availability':t['availability'],'mode':mode,'reason':reason,'parameters':{k:{kk:vv for kk,vv in v.items() if kk in keep} for k,v in t['parameters'].items()},'native_flags':contract['flags'],'usage':usage,'source':'official-runtime-schema'})
for command,u in utilities.items():
 if u['children']:continue
 mode='local_workflow';reason='Local authentication, installation, configuration or maintenance workflow; not a remote business API'
 if command in ['auth status','profile list','config list','version','doctor']:mode='utility_adapter';reason='Explicit read-only diagnostic adapter'
 if command in ['cache','recovery']:mode='unavailable';reason='Official compatibility placeholder; no current functionality'
 if command=='api':mode='raw_adapter';reason='Official-domain Raw OpenAPI adapter; requires a separately configured custom app credential pair'
 flags={};params={};local=True
 for line in u['help'].splitlines():
  if line.startswith('Global Flags:'):local=False
  m=re.match(r'^\s+(?:-\w,\s+)?--([\w-]+)(?:\s+([A-Za-z][\w\[\]]*))?\s{2,}(.*)',line)
  if m:
   kind=m[2] or 'bool';flags[m[1]]={'kind':kind,'local':local}
   if local and m[1] not in ['help','profile']:params[m[1]]={'type':'boolean' if kind=='bool' else 'integer' if kind in ['int','int64'] else 'array' if kind in ['strings','stringArray'] else 'string','required':False,'description':m[3]}
 entries.append({'command':command,'product':command.split()[0],'description':u['help'].split('\n')[0],'effect':'local','risk':'local','confirmation':'local_workflow','availability':'local','mode':mode,'reason':reason,'parameters':params,'native_flags':flags,'usage':[],'local_help':u['help'],'source':'official-utility-help'})
seen=set()
for e in entries:
 if e['command'] in seen:raise RuntimeError('duplicate command '+e['command'])
 seen.add(e['command'])
summary={'version':'1.0.67','native_schema_count':sum(len(p['tools']) for p in x['products']),'schema_hash':x['catalog_hash'],'utility_leaf_count':sum(not u['children'] for u in utilities.values()),'command_count':len(entries),'modes':dict(Counter(e['mode'] for e in entries)),'products':[{'id':p['id'],'name':p['name'],'description':p['description'],'count':len(p['tools'])} for p in x['products']]}
(root/'mcp/workspace-catalog.json').write_text(json.dumps({'summary':summary,'commands':entries},ensure_ascii=False,indent=2)+'\n')
with (root.parents[1]/'CLI-COVERAGE.csv').open('w',newline='') as f:
 w=csv.writer(f);w.writerow(['command','product','mode','effect','risk','availability','reason'])
 for e in entries:w.writerow([e[k] for k in ['command','product','mode','effect','risk','availability','reason']])
print(json.dumps(summary,ensure_ascii=False))
