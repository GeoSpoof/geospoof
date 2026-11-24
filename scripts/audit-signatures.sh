#!/usr/bin/env bash
# `npm audit signatures`, retried only when the registry failed to answer.
#
# Why this exists: some Cloudflare locations in front of registry.npmjs.org have cached a 4-byte
# `text/plain` "OK" body for individual attestation URLs, with a one-year max-age. Measured on
# 2026-11-24: /-/npm/v1/attestations/playwright@1.65.1 returned the real 15 KB JSON from IAD and
# "OK" from ATL, alternating between consecutive requests from one machine. npm reports that as
# FETCH_ERROR ("invalid json response body ... Unexpected token 'O'"), and because the bad body
# arrives with a 200, npm's own fetch retries never fire. A second attempt usually lands on a
# healthy location.
#
# Only registry fetch and network failures are retried. A package whose signature or attestation
# is invalid or missing is the thing this check exists to catch: npm reports that as a
# verification result, not as one of the codes below, so it fails on the first attempt and is
# never retried.
#
# Used by this repo's ci.yml, cdk-ci.yml and release.yml, and by geospoof-ios's
# build-extension.yml, which runs it from its checkout of this repo. geospoof-site keeps a copy;
# change both together.
#
# Usage: scripts/audit-signatures.sh  (from the directory holding package-lock.json)
# Env:   AUDIT_SIGNATURES_ATTEMPTS (default 3), AUDIT_SIGNATURES_DELAY seconds (default 10)
set -uo pipefail

attempts="${AUDIT_SIGNATURES_ATTEMPTS:-3}"
delay="${AUDIT_SIGNATURES_DELAY:-10}"
# npm >= 10 prints `npm error code <X>`; older releases printed `npm ERR! code <X>`.
retryable='^npm (error|ERR!) code (FETCH_ERROR|ECONNRESET|ETIMEDOUT|EAI_AGAIN|E500|E502|E503|E504)$'

log="$(mktemp)"
trap 'rm -f "$log"' EXIT

attempt=1
while :; do
  npm audit signatures >"$log" 2>&1
  status=$?
  cat "$log"
  if [ "$status" -eq 0 ]; then
    exit 0
  fi
  code="$(grep -m1 -oE "$retryable" "$log" | awk '{print $NF}')"
  if [ -z "$code" ]; then
    exit "$status" # a verification failure or anything else: never retried
  fi
  if [ "$attempt" -ge "$attempts" ]; then
    echo "::error::npm audit signatures could not reach the registry ($code) after $attempts attempts" >&2
    exit "$status"
  fi
  echo "::warning::npm audit signatures got a registry error ($code) on attempt $attempt of $attempts; retrying in ${delay}s" >&2
  attempt=$((attempt + 1))
  sleep "$delay"
done
