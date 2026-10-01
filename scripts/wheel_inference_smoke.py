"""Run with a clean wheel-installed interpreter (-I), from outside the checkout.

Pass an explicit model/cache directory and receipt path. Reuses verified assets;
this is packaging/inference plumbing evidence, not quality evaluation.
"""
import hashlib
import importlib.metadata
import json
import math
from pathlib import Path
import sys
import time
import local_decider
import semif_phase1
from local_decider.lock import load_lock, verify_weights
from local_decider.scoring import LocalScorer

root, output = map(Path, sys.argv[1:3])
prefix = Path(sys.prefix).resolve()
for module in (local_decider, semif_phase1):
    assert Path(module.__file__).resolve().is_relative_to(prefix), module.__file__
lock = load_lock()
assert lock.path.resolve().is_relative_to(prefix)
check = verify_weights(lock, root)
assert check['matches'], check
started = time.monotonic()
scorer = LocalScorer.load(lock, root)
try:
    result = scorer.score_question({'kind':'choice','id':'package-probe','instructions':'Does reading a local text file modify it?', 'options':[{'id':'read','description':'The operation only reads the file.'},{'id':'write','description':'The operation changes the file.'}]}, {'userTask':'Inspect a local text file', 'call':{'toolName':'read_file'}})
    probabilities = result['probabilities']
    assert len(probabilities) == 2 and all(math.isfinite(p) for p in probabilities)
    assert abs(sum(probabilities)-1) < 1e-5
    report = {'passed':True,'scope':'clean installed wheel plus all runtime dependencies; real CPU model load and one diagnostic score; no efficacy claim', 'interpreter':sys.executable,'localDecider':local_decider.__file__,'semif':semif_phase1.__file__,'bundledLock':str(lock.path),'weightsCheck':check,'identity':scorer.identity,'probabilities':probabilities,'elapsedSeconds':round(time.monotonic()-started,3),'dependencies':{d.metadata['Name']:d.version for d in importlib.metadata.distributions()}}
    output.write_text(json.dumps(report,indent=2)+'\n')
    print(json.dumps({'passed':True,'receipt':str(output),'seconds':report['elapsedSeconds']}))
finally:
    scorer.close()
