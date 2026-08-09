#!/usr/bin/env bash
# Generate requirements.txt: fully resolved, hash-pinned, reproducible.
#
# Runs pip-compile INSIDE the pinned base image. That is the whole point — the
# resolution must happen on the target platform, Python version and ABI, or the
# hashes describe wheels the image will never install.
#
# Requires: docker, network egress. This is a provisioning-time tool; it is
# never run at runtime and never inside the running pod.
set -euo pipefail
cd "$(dirname "$0")"

# shellcheck disable=SC1091
source ./versions.env

echo "==> resolving against ${BASE_IMAGE_HUMAN}"
echo "    ${BASE_IMAGE_REF}"

docker run --rm \
  -v "$PWD":/w -w /w \
  "${BASE_IMAGE_REF}" \
  bash -eu -c '
    pip install --no-cache-dir --quiet "pip-tools==7.4.1"
    pip-compile \
      --generate-hashes \
      --allow-unsafe \
      --strip-extras \
      --output-file=requirements.txt \
      requirements.in
  '

if grep -q 'ERROR-MARKER-UNLOCKED' requirements.txt; then
  echo "!! pip-compile did not overwrite the lock. Aborting." >&2
  exit 1
fi

hashes=$(grep -c -- '--hash=sha256:' requirements.txt || true)
echo "==> wrote requirements.txt with ${hashes} hashes"
[ "${hashes}" -gt 50 ] || {
  echo "!! only ${hashes} hashes — the docling closure should be far larger." >&2
  echo "   Refusing to accept a suspiciously small lock." >&2
  exit 1
}

echo "==> next: rebuild the image, then run compat_check.py before trusting the pin"
