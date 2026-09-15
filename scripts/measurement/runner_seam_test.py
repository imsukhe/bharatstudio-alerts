import importlib.util
from pathlib import Path
spec=importlib.util.spec_from_file_location('runner',Path(__file__).with_name('run_local_measurement.py')); mod=importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)
times=iter(['2026-09-15T10:00:00+00:00','2026-09-15T10:00:01+00:00'])
a=mod.run(deps={'docker_available':True,'migration_ok':True,'load_report':{'p50':1,'p95':2,'p99':3},'port':55123,'now':times.__next__})
assert a['overall']=='local-smoke-only' and a['statuses']['load']=='smoke-pass' and '55123' in ' '.join(a['commands'])
b=mod.run(deps={'docker_available':True,'migration_ok':True,'load_report':{'p50':1,'p95':2},'now':lambda:'2026-09-15T10:00:00+00:00'})
assert b['overall']=='blocked' and b['statuses']['load']=='fail'
c=mod.run(deps={'docker_available':True,'migration_ok':False,'cleanup_ok':False,'now':lambda:'2026-09-15T10:00:00+00:00'})
assert c['overall']=='blocked' and c['statuses']['database']=='fail'
d=mod.run(deps={'docker_available':False,'now':lambda:'2026-09-15T10:00:00+00:00'})
assert d['overall']=='blocked' and d['statuses']['database']=='blocked'
print('runner seam tests: 4 passed')

