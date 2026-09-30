#!/usr/bin/env bash
# Copies Terraform's github_variables output into the repo's GitHub Actions variables.
set -euo pipefail
dir="$(cd "$(dirname "$0")/../staging" && pwd)"
repo="$(cd "$dir" && terraform output -raw -no-color github_repository 2>/dev/null || grep github_repository "$dir/terraform.tfvars" | sed -E 's/.*"([^"]+)".*/\1/')"
cd "$dir"
terraform output -json github_variables | python3 -c '
import json, subprocess, sys
for k, v in json.load(sys.stdin).items():
    subprocess.run(["gh", "variable", "set", k, "--repo", sys.argv[1], "--body", v], check=True)
    print("set", k)
' "$repo"
