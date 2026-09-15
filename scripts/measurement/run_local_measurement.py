#!/usr/bin/env python3
"""Truthful local measurement runner; smoke validation never implies full evidence."""
import argparse, json, os, shutil, subprocess, sys, tempfile, time
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
INFRA = ROOT.parent / "bharatstudio-infra"
ALLOWED_STATUS = {"pass", "smoke-pass", "blocked", "not-run", "fail"}

def validate_artifact(artifact: dict) -> list[str]:
    """Validate the redacted artifact before it can be atomically written."""
    errors = []
    required = ("schema", "version", "mode", "overall", "identity", "commands", "startedAt", "finishedAt", "statuses", "blockers", "rollback", "externalEvidence", "redacted")
    errors.extend(f"missing {key}" for key in required if key not in artifact)
    if artifact.get("schema") != "bharatstudio.measurement.v1": errors.append("unknown schema")
    if artifact.get("mode") not in {"smoke", "full"}: errors.append("invalid mode")
    if artifact.get("overall") not in {"local-smoke-only", "blocked"}: errors.append("invalid overall status")
    if artifact.get("externalEvidence") != "not-claimed" or artifact.get("redacted") is not True: errors.append("external evidence/redaction boundary violated")
    if artifact.get("finishedAt", "") < artifact.get("startedAt", ""): errors.append("reversed timestamps")
    if any(value not in ALLOWED_STATUS for value in artifact.get("statuses", {}).values()): errors.append("unknown status")
    if not isinstance(artifact.get("commands"), list) or not all(isinstance(x, str) and not any(token in x.lower() for token in ("postgres://", "password=", "secret=")) for x in artifact.get("commands", [])): errors.append("unsafe command record")
    serialized = json.dumps(artifact).lower()
    if "postgres://" in serialized or "razorpay_key_secret" in serialized or "begin private key" in serialized: errors.append("raw secret/payload in artifact")
    for key in ("p50", "p95", "p99"):
        if key not in artifact.get("percentiles", {}): errors.append(f"missing percentile {key}")
    if artifact.get("statuses", {}).get("load") == "smoke-pass" and any(artifact["percentiles"].get(k) is None for k in ("p50", "p95", "p99")): errors.append("smoke-pass load requires p50/p95/p99")
    return errors

def run(options=None, deps=None):
    """Deterministic seam; injected dependencies avoid Docker/filesystem in tests."""
    options = options or argparse.Namespace(artifact=None, full=False)
    deps = deps or {}
    now = deps.get("now", lambda: datetime.now(timezone.utc).isoformat())
    port = deps.get("port", 55441)
    statuses = {"manifest":"pass", "migrationInventory":"pass", "database":"not-run", "load":"not-run", "cleanup":"not-run", "provider":"blocked", "obs":"not-run", "devices":"not-run", "network":"not-run", "targetConcurrency":"not-run"}
    commands = ["infra manifest validator", f"loopback postgres port {port}"]
    blockers = []
    if not deps.get("docker_available", False):
        statuses["database"]="blocked"; blockers.append("Docker unavailable")
    elif not deps.get("migration_ok", True):
        statuses["database"]="fail"; blockers.append("migration failure")
    else:
        statuses["database"]="smoke-pass"; commands += ["roles + ordered migrations"]
        report = deps.get("load_report")
        if report is None: statuses["load"]="not-run"; blockers.append("load not supplied")
        else:
            try:
                percentiles = {k: report[k] for k in ("p50", "p95", "p99")}
                if any(v is None for v in percentiles.values()): raise ValueError
                statuses["load"]="smoke-pass"; commands.append("bounded load harness")
            except (KeyError, ValueError): statuses["load"]="fail"; percentiles={"p50":None,"p95":None,"p99":None}; blockers.append("load JSON missing p50/p95/p99")
        statuses["cleanup"]="pass" if deps.get("cleanup_ok", True) else "fail"
    percentiles = locals().get("percentiles", {"p50":None,"p95":None,"p99":None})
    artifact={"schema":"bharatstudio.measurement.v1","version":1,"environment":"local-disposable","mode":"full" if options.full else "smoke","overall":"blocked" if options.full or statuses["database"] in ("blocked","fail") or statuses["load"]=="fail" else "local-smoke-only","identity":"local-loopback-only","commands":commands,"startedAt":now(),"finishedAt":now(),"statuses":statuses,"percentiles":percentiles,"blockers":blockers,"rollback":{"status":statuses["cleanup"],"scope":"named-disposable-only"},"externalEvidence":"not-claimed","redacted":True}
    errors=validate_artifact(artifact)
    if errors: artifact["overall"]="blocked"; artifact["blockers"] += errors
    if deps.get("write"):
        deps["write"](artifact)
    return artifact

def _invalid_artifact_target(raw: str | None) -> tuple[Path | None, str | None]:
    """Validate the output target before any manifest, temp-file, or Docker work."""
    if raw is None:
        return None, None
    if not raw.strip():
        return None, "artifact target is empty"
    target = Path(raw).expanduser()
    try:
        resolved = target.resolve()
    except OSError:
        return None, "artifact target cannot be resolved"
    if resolved == Path.cwd():
        return None, "artifact target must be a file, not the current directory"
    if target.exists() and target.is_dir():
        return None, "artifact target must be a file, not a directory"
    parent = target.parent.resolve()
    if not parent.exists() or not parent.is_dir():
        return None, "artifact parent directory does not exist"
    # os.access is misleading when tests run as root; mode bits are the
    # deterministic portability guard for a non-writable parent.
    if parent.stat().st_mode & 0o222 == 0:
        return None, "artifact parent directory is not writable"
    return target, None

def _blocked_artifact(reason: str) -> dict:
    now = datetime.now(timezone.utc).isoformat()
    return {"schema":"bharatstudio.measurement.v1", "version":1, "environment":"local-disposable", "mode":"smoke", "overall":"blocked", "identity":"local-loopback-only", "commands":[], "startedAt":now, "finishedAt":now, "statuses":{"manifest":"not-run","migrationInventory":"not-run","database":"not-run","load":"not-run","cleanup":"not-run","provider":"blocked","obs":"not-run","devices":"not-run","network":"not-run","targetConcurrency":"not-run"}, "percentiles":{"p50":None,"p95":None,"p99":None}, "blockers":[reason], "rollback":{"status":"not-run","scope":"named-disposable-only"}, "externalEvidence":"not-claimed", "redacted":True}

def _execute(options=None, deps=None) -> int:
    ap = argparse.ArgumentParser(description="run local disposable measurement checks")
    ap.add_argument("--artifact", type=str, default=None)
    ap.add_argument("--full", action="store_true", help="require external harnesses; never auto-provision")
    args = options or ap.parse_args()
    artifact_target, target_error = _invalid_artifact_target(args.artifact)
    if target_error:
        print(json.dumps(_blocked_artifact(target_error), sort_keys=True, separators=(",", ":")))
        return 2
    started_at = datetime.now(timezone.utc).isoformat()
    # Generate an ephemeral executable manifest with loopback-only values; it is
    # never persisted or applied to cloud infrastructure.
    template = json.loads((INFRA / "deployment/v1/measurement-manifest.template.json").read_text())
    executable = json.loads(json.dumps(template)); executable["deploymentState"] = "local-executable"; executable["region"] = "local-loopback"; executable["project"] = "local-project"; executable["domain"] = "local-loopback"; executable["capacity"] = {"maxInstances": 1, "concurrency": 10, "budget": "local-smoke"}
    port = 55441 + (os.getpid() % 1000)
    executable["database"].update({"url":f"postgres://postgres:test@127.0.0.1:{port}/postgres", "directListener":f"postgres://postgres:test@127.0.0.1:{port}/postgres", "maxRows":100000, "indexes":"local-schema-smoke"})
    executable["harness"] = {"obs":"local-pinned-absent", "chromium":"local-pinned-absent", "android":"local-device-absent", "ios":"local-device-absent"}
    for service in executable["services"]: service["digest"] = "sha256:" + ("0" * 64)
    with tempfile.NamedTemporaryFile(prefix="bharatstudio-measurement-", suffix=".json", delete=False) as f:
        manifest_path = Path(f.name); f.write(json.dumps(executable).encode())
    validator = subprocess.run(["node", str(INFRA / "tools/validate-measurement-manifest.mjs"), "--local-executable", f"--manifest={manifest_path}"], cwd=INFRA, capture_output=True, text=True)
    manifest_path.unlink(missing_ok=True)
    migrations = sorted((ROOT / "packages/db/migrations").glob("*.sql"))
    commands = ["infra manifest validator", "migration inventory"]
    statuses = {"manifest": "pass" if validator.returncode == 0 else "fail", "migrationInventory": "pass" if migrations else "fail", "database": "not-run", "load": "not-run", "cleanup": "not-run", "provider": "blocked", "obs": "not-run", "devices": "not-run", "network": "not-run", "targetConcurrency": "not-run"}
    blockers = ["Razorpay sandbox reference/credentials not supplied", "Cloud Run/IAM staging not provisioned", "OBS, device and network harnesses not available"]
    container = f"bharatstudio-measurement-{os.getpid()}"
    percentiles = {"p50":None,"p95":None,"p99":None}
    docker = shutil.which("docker")
    if docker and validator.returncode == 0:
        commands += ["docker run postgres:16-alpine loopback", "pg_isready readiness", "roles + ordered migrations"]
        started = subprocess.run([docker,"run","--rm","--detach","--name",container,"-e","POSTGRES_PASSWORD=test","-p",f"127.0.0.1:{port}:5432","postgres:16-alpine"],capture_output=True,text=True)
        if started.returncode == 0:
            try:
                ready = False
                for _ in range(30):
                    probe = subprocess.run([docker,"exec",container,"pg_isready","-U","postgres","-d","postgres"],capture_output=True)
                    if probe.returncode == 0: ready=True; break
                    time.sleep(1)
                if ready:
                    statuses["database"] = "smoke-pass"
                    # Apply the role baseline and every migration in lexical order.
                    for sql in [ROOT / "packages/db/roles/0001_v1_service_roles.sql", *migrations]:
                        commands.append(f"psql {sql.name}")
                        result = subprocess.run([docker,"exec","-i",container,"psql","-v","ON_ERROR_STOP=1","-U","postgres","-d","postgres"],input=sql.read_text(),text=True,capture_output=True)
                        if result.returncode: statuses["database"]="fail"; blockers.append("migration failed; redacted stderr retained locally"); break
                    if statuses["database"] == "smoke-pass":
                        load_cmd = ROOT / "apps/api/node_modules/.bin/tsx"
                        harness = ROOT / "scripts/load/load-harness.ts"
                        if load_cmd.exists() and harness.exists():
                            commands.append("bounded load harness 20 tips/5 workers")
                            load = subprocess.run([str(load_cmd), str(harness)], cwd=ROOT, env={**os.environ, "DATABASE_URL_DIRECT":f"postgres://postgres:test@127.0.0.1:{port}/postgres", "LOAD_TIP_COUNT":"20", "LOAD_CONCURRENCY":"5"}, capture_output=True, text=True)
                            try:
                                report = json.loads(load.stdout)
                                percentiles = {"p50":report.get("latencyMsP50"),"p95":report.get("latencyMsP95"),"p99":report.get("latencyMsP99")}
                                if percentiles["p50"] is None or percentiles["p95"] is None: raise ValueError("load JSON missing required percentile")
                            except (ValueError, json.JSONDecodeError):
                                load = subprocess.CompletedProcess(load.args, 1, load.stdout, load.stderr)
                                blockers.append("load JSON lacked required p50/p95/p99 percentiles")
                            statuses["load"] = "smoke-pass" if load.returncode == 0 else "fail"
                            if load.returncode: blockers.append("bounded load harness failed; output redacted from artifact")
                        else:
                            statuses["load"] = "not-run"; blockers.append("bounded Alerts load harness is unavailable")
                else: statuses["database"]="blocked"; blockers.append("PostgreSQL16 container did not become ready")
            finally:
                stopped = subprocess.run([docker,"rm","-f",container],capture_output=True)
                statuses["cleanup"] = "pass" if stopped.returncode == 0 else "fail"
                rollback_status = "pass" if stopped.returncode == 0 else "fail"
        else:
            statuses["database"]="blocked"; blockers.append("Docker PostgreSQL16 container could not start")
    else:
        statuses["database"]="blocked"; statuses["cleanup"]="not-run"; blockers.append("Docker is unavailable; PostgreSQL16 smoke, migrations, load and cleanup are blocked")
    overall = "local-smoke-only" if statuses["manifest"] == "pass" and statuses["database"] in ("smoke-pass","not-run") and statuses["load"] in ("smoke-pass","not-run") else "blocked"
    if args.full: blockers.append("full-volume target concurrency requires approved non-production environment"); overall="blocked"
    artifact = {"schema":"bharatstudio.measurement.v1", "version":1, "environment":"local-disposable", "mode":"full" if args.full else "smoke", "overall":overall, "identity":"local-loopback-only", "commands":commands, "startedAt":started_at, "finishedAt":datetime.now(timezone.utc).isoformat(), "manifest":"../bharatstudio-infra/deployment/v1/measurement-manifest.template.json", "migrationCount":len(migrations), "statuses":statuses, "percentiles":percentiles, "blockers":blockers, "rollback":{"status":locals().get("rollback_status", "not-run"),"scope":"named-disposable-only"}, "externalEvidence":"not-claimed", "redacted":True}
    artifact_errors = validate_artifact(artifact)
    if artifact_errors:
        artifact["overall"] = "blocked"; artifact["blockers"].extend(artifact_errors)
    payload=json.dumps(artifact, sort_keys=True, separators=(",",":"))+"\n"
    if artifact_target:
        fd,tmp=tempfile.mkstemp(prefix=".measurement-", dir=artifact_target.parent); os.write(fd,payload.encode()); os.close(fd); os.replace(tmp,artifact_target)
    print(payload, end="")
    return 2 if args.full or statuses["database"] == "blocked" else (1 if validator.returncode or statuses["load"] == "fail" else 0)
def main() -> int:
    return _execute()
if __name__ == "__main__": raise SystemExit(main())
