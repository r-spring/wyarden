#!/usr/bin/env python3
"""Deploy public/ to Firebase Hosting on wyarden-web. Prints no tokens."""
import gzip
import hashlib
import json
import subprocess
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path("/home/robert/Dev Stuff/wyarden/public")
PROJECT = "wyarden-web"
SITE = "wyarden-web"
ACCOUNT = "robertacspring@gmail.com"


def token():
    out = subprocess.check_output(
        [
            "gcloud",
            "auth",
            "print-access-token",
            "--account",
            ACCOUNT,
        ],
        env={
            **dict(**{k: v for k, v in __import__("os").environ.items()}),
            "CLOUDSDK_BILLING_QUOTA_PROJECT": "questcard-502520",
            "CLOUDSDK_CORE_PROJECT": PROJECT,
        },
        text=True,
    )
    return out.strip()


def call(method, url, body=None, raw=None, content_type="application/json"):
    data = raw if raw is not None else (None if body is None else json.dumps(body).encode())
    headers = {
        "Authorization": f"Bearer {token()}",
        "X-Goog-User-Project": PROJECT,
    }
    if data is not None and content_type:
        headers["Content-Type"] = content_type
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            raw_body = r.read()
            if not raw_body:
                return r.status, {}
            return r.status, json.loads(raw_body.decode())
    except urllib.error.HTTPError as e:
        text = e.read().decode()
        try:
            payload = json.loads(text)
        except json.JSONDecodeError:
            payload = {"raw": text[:800]}
        return e.code, payload


def show(label, status, payload):
    err = payload.get("error") if isinstance(payload, dict) else None
    msg = ""
    if isinstance(err, dict):
        msg = err.get("message", "")[:400]
    print(label, status, msg or (payload.get("name") if isinstance(payload, dict) else ""))


status, sites = call(
    "GET",
    f"https://firebasehosting.googleapis.com/v1beta1/projects/{PROJECT}/sites",
)
show("sites", status, sites if isinstance(sites, dict) else {})
if isinstance(sites, dict) and sites.get("sites"):
    print(" site ids", [s.get("name") for s in sites["sites"]])
elif isinstance(sites, dict):
    print(json.dumps(sites)[:800])

status, version = call(
    "POST",
    f"https://firebasehosting.googleapis.com/v1beta1/sites/{SITE}/versions",
    {
        "config": {
            "headers": [
                {
                    "glob": "**",
                    "headers": {"Cache-Control": "public, max-age=300"},
                }
            ]
        }
    },
)
show("version", status, version if isinstance(version, dict) else {})
if status >= 300:
    print(json.dumps(version)[:1500])
    raise SystemExit(1)
version_name = version["name"]
print(" version", version_name)

files = {}
blobs = {}
for path in sorted(ROOT.rglob("*")):
    if not path.is_file():
        continue
    rel = "/" + path.relative_to(ROOT).as_posix()
    gz = gzip.compress(path.read_bytes(), mtime=0)
    digest = hashlib.sha256(gz).hexdigest()
    files[rel] = digest
    blobs[digest] = gz
    print(" file", rel, digest[:12], "gz", len(gz))

status, populated = call(
    "POST",
    f"https://firebasehosting.googleapis.com/v1beta1/{version_name}:populateFiles",
    {"files": files},
)
show("populate", status, populated if isinstance(populated, dict) else {})
if status >= 300:
    print(json.dumps(populated)[:1500])
    raise SystemExit(1)
upload_url = populated.get("uploadUrl")
needed = populated.get("uploadRequiredHashes") or []
print(" upload", len(needed), "of", len(files))
for digest in needed:
    code, payload = call(
        "POST",
        upload_url + "/" + digest,
        raw=blobs[digest],
        content_type="application/octet-stream",
    )
    print("  put", digest[:12], code, (payload.get("error") or {}).get("message", "")[:200] if isinstance(payload, dict) else "")
    if code >= 300:
        print(json.dumps(payload)[:800])
        raise SystemExit(1)

status, finalized = call(
    "PATCH",
    f"https://firebasehosting.googleapis.com/v1beta1/{version_name}?updateMask=status",
    {"status": "FINALIZED"},
)
show("finalize", status, finalized if isinstance(finalized, dict) else {})
if status >= 300:
    print(json.dumps(finalized)[:1500])
    raise SystemExit(1)

status, release = call(
    "POST",
    f"https://firebasehosting.googleapis.com/v1beta1/sites/{SITE}/channels/live/releases?versionName={version_name}",
    {},
)
show("release", status, release if isinstance(release, dict) else {})
if status >= 300:
    print(json.dumps(release)[:1500])
    raise SystemExit(1)
print("release name", release.get("name") if isinstance(release, dict) else release)
print("DONE")
