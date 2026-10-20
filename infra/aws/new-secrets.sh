#!/usr/bin/env bash
# Prints fresh random values for the GENERATE fields of env.example (OPS-03).
# Run it once, on any machine with openssl, and copy the values into the
# settings secret. Database passwords are hex, so they need no URL escaping.
set -euo pipefail
hex() { openssl rand -hex "$1"; }
echo "workeasy_owner password:  $(hex 24)"
echo "workeasy_api password:    $(hex 24)"
echo "workeasy_worker password: $(hex 24)"
echo "workeasy_public password: $(hex 24)"
echo "SESSION_SECRET=$(hex 32)"
echo "INTEGRATION_SECRET_KEY=$(openssl rand -base64 32)"
