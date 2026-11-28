"""Verify the exact final VSIX and its unpacked VS Code extension directory."""

import argparse
import hashlib
import json
from pathlib import Path
from zipfile import ZipFile


def require(condition, detail):
    if not condition:
        raise SystemExit(detail)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("vsix", type=Path)
    parser.add_argument("installed_extension", type=Path)
    args = parser.parse_args()
    expected = json.loads(Path(__file__).with_name("final-install.json").read_text(encoding="utf-8"))

    digest = hashlib.sha256(args.vsix.read_bytes()).hexdigest().upper()
    require(digest == expected["sha256"], "VSIX SHA-256 differs from the acceptance receipt")
    require(args.vsix.stat().st_size == expected["archiveBytes"], "VSIX length differs")

    root = args.installed_extension
    with ZipFile(args.vsix) as archive:
        entries = archive.infolist()
        require(len(entries) == expected["archiveEntries"], "VSIX entry count differs")
        payload = {
            entry.filename.removeprefix("extension/"): entry
            for entry in entries
            if entry.filename.startswith("extension/") and not entry.is_dir()
        }
        require(len(payload) == expected["payloadFiles"], "VSIX payload count differs")
        installed = {p.relative_to(root).as_posix() for p in root.rglob("*") if p.is_file()}
        require(installed == set(payload) | {".vsixmanifest"}, "Installed file set differs")
        require((root / ".vsixmanifest").read_bytes() == archive.read("extension.vsixmanifest"),
                "VS Code's installed .vsixmanifest differs")

        for name, entry in payload.items():
            packaged = archive.read(entry)
            actual = (root / name).read_bytes()
            if name == "package.json":
                manifest = json.loads(actual)
                require("__metadata" in manifest, "Editor-added manifest metadata is missing")
                del manifest["__metadata"]
                require(manifest == json.loads(packaged), "Installed package.json differs")
            else:
                require(actual == packaged, f"Installed payload differs at {name}")

    print(f"Verified {digest} and {len(payload)} installed payload files")


if __name__ == "__main__":
    main()
