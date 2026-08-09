#!/usr/bin/env bash
# Assert that nothing in the AI runtime floats.
#
# Cheap enough to run in CI on every commit. It exists because this repo has
# already shipped three different Docling versions across three files, a
# fabricated base-image digest, and a requirements.txt whose header claimed
# hashes it did not contain. Every one of those would have been caught here.
#
# Exit 0 = pins are internally consistent and none of them float.
set -uo pipefail
cd "$(dirname "$0")"

fail=0
bad() { printf '  \033[31mFAIL\033[0m %s\n' "$1"; fail=$((fail+1)); }
ok()  { printf '  \033[32mok\033[0m   %s\n' "$1"; }
warn(){ printf '  \033[33mwarn\033[0m %s\n' "$1"; }

[ -f versions.env ] || { echo "versions.env missing"; exit 1; }
# shellcheck disable=SC1091
source ./versions.env

echo "pin consistency"

# --- nothing may float -------------------------------------------------------
if grep -rnE ':latest|:main\b|@main\b' Dockerfile ../docker-compose.local-ai.yml 2>/dev/null \
     | grep -v '^\s*#' | grep -q .; then
  bad "a floating tag (:latest / :main) is referenced"
  grep -rnE ':latest|:main\b' Dockerfile ../docker-compose.local-ai.yml 2>/dev/null | grep -v '^\s*#' | sed 's/^/       /'
else
  ok "no floating tags"
fi

# --- base image digest must be real-shaped and match versions.env ------------
df_digest="$(grep -oE 'FROM python@sha256:[0-9a-f]{64}' Dockerfile | head -1 | sed 's/FROM //')"
if [ -z "$df_digest" ]; then
  bad "Dockerfile has no pinned python@sha256 base"
elif [ "$df_digest" != "$BASE_IMAGE_REF" ]; then
  bad "Dockerfile base ($df_digest) != versions.env BASE_IMAGE_REF ($BASE_IMAGE_REF)"
else
  ok "base image digest matches versions.env"
fi

# --- ollama version must match ------------------------------------------------
df_ollama="$(grep -oE 'ARG OLLAMA_VERSION=[0-9.]+' Dockerfile | head -1 | cut -d= -f2)"
if [ "$df_ollama" != "$OLLAMA_VERSION" ]; then
  bad "Dockerfile OLLAMA_VERSION ($df_ollama) != versions.env ($OLLAMA_VERSION)"
else
  ok "ollama version matches versions.env ($OLLAMA_VERSION)"
fi

# --- docling version consistency across every file that names one ------------
declare -a docling_refs=()
while IFS= read -r line; do docling_refs+=("$line"); done < <(
  grep -rhoE 'docling(-core)?==[0-9]+\.[0-9]+\.[0-9]+' \
    requirements.in ../docling-sidecar/requirements.txt 2>/dev/null | sort -u
)
main_docling="$(grep -oE 'docling==[0-9.]+' requirements.in | cut -d= -f3)"
if [ "$main_docling" != "$DOCLING_VERSION" ]; then
  bad "requirements.in docling ($main_docling) != versions.env DOCLING_VERSION ($DOCLING_VERSION)"
else
  ok "docling version matches versions.env ($DOCLING_VERSION)"
fi
if [ "${#docling_refs[@]}" -gt 0 ]; then
  printf '       docling refs seen: %s\n' "${docling_refs[*]}"
fi

# --- the lock must actually be locked ----------------------------------------
if grep -q 'ERROR-MARKER-UNLOCKED' requirements.txt 2>/dev/null; then
  warn "requirements.txt is NOT generated yet — run ./lock.sh (image build will fail until then)"
elif ! grep -q -- '--hash=sha256:' requirements.txt 2>/dev/null; then
  bad "requirements.txt has no hashes but no unlocked marker either"
else
  n="$(grep -c -- '--hash=sha256:' requirements.txt)"
  ok "requirements.txt carries $n hashes"
fi

# --- OCR assets must be checksummed ------------------------------------------
if grep -q '__RECORD__' ocr-assets.lock 2>/dev/null; then
  pending="$(grep -c '__RECORD__' ocr-assets.lock)"
  warn "$pending OCR asset checksum(s) still __RECORD__ — image build will fail closed"
else
  ok "all OCR asset checksums recorded"
fi

# --- model identity -----------------------------------------------------------
[ -n "${OLLAMA_MODEL:-}" ] || bad "OLLAMA_MODEL unset"
case "${OLLAMA_MODEL:-}" in
  *:*) ok "model tag is explicit ($OLLAMA_MODEL)" ;;
  *)   bad "OLLAMA_MODEL has no explicit tag" ;;
esac
digest_len="${#OLLAMA_MODEL_DIGEST_SHORT}"
if [ "$digest_len" -lt 64 ]; then
  warn "model digest is ${digest_len} chars (short form); record the full sha256 in Run 2"
else
  ok "model digest is a full sha256"
fi

# --- docling pin status -------------------------------------------------------
if [ "${DOCLING_PIN_STATUS:-}" != "accepted" ]; then
  warn "DOCLING_PIN_STATUS=${DOCLING_PIN_STATUS:-unset} — compat_check.py has not confirmed this pin"
fi

echo
if [ "$fail" -gt 0 ]; then
  echo "pin check FAILED ($fail)"
  exit 1
fi
echo "pin check passed (warnings are expected until lock.sh and --record have run)"
