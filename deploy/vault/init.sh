#!/bin/sh
# Starts the local Vault for docker compose and prepares it for OIC-Replica:
#   - initialises it once (1 unseal key, kept in its own data volume) and unseals it on every start
#   - enables a KV v2 engine at oicr/
#   - writes the oicr-platform policy (tenant credentials only) and a renewable token for it,
#     shared with the app containers through the vault-token volume
# This keeps the unseal key next to the data, which is fine on a laptop and wrong in
# production: there, point VAULT_ADDR at a real Vault and use AppRole or Kubernetes auth.
set -eu

export VAULT_ADDR=http://127.0.0.1:8200
keys=/vault/file/.oicr-init
token_file=/vault/token/token
rm -f /vault/token/ready

vault server -config=/vault/config/config.hcl &
server=$!
trap 'kill -TERM "$server" 2>/dev/null; wait "$server"' TERM INT

# vault status: 0 = unsealed, 2 = sealed, 1 = not answering yet.
until rc=0; vault status >/dev/null 2>&1 || rc=$?; [ "$rc" -ne 1 ]; do sleep 0.5; done

if ! vault status -format=json | grep -q '"initialized": true'; then
  vault operator init -key-shares=1 -key-threshold=1 > "$keys.tmp"
  mv "$keys.tmp" "$keys"
  chmod 600 "$keys"
  echo "vault: initialised"
fi
vault operator unseal "$(sed -n 's/^Unseal Key 1: //p' "$keys")" >/dev/null
VAULT_TOKEN="$(sed -n 's/^Initial Root Token: //p' "$keys")"
export VAULT_TOKEN

vault secrets list -format=json | grep -q '"oicr/"' || vault secrets enable -path=oicr -version=2 kv >/dev/null
vault policy write oicr-platform - >/dev/null <<'POLICY'
path "oicr/data/tenants/*" {
  capabilities = ["create", "update", "read"]
}
path "oicr/metadata/tenants/*" {
  capabilities = ["delete"]
}
POLICY

# Reuse the app token while it is valid; otherwise issue a new one (periodic: renewed by the apps).
if [ ! -s "$token_file" ] || ! VAULT_TOKEN="$(cat "$token_file")" vault token lookup >/dev/null 2>&1; then
  vault token create -policy=oicr-platform -period=768h -orphan -display-name=oicr-platform -field=token > "$token_file.tmp"
  mv "$token_file.tmp" "$token_file"
  echo "vault: issued a platform token"
fi
chmod 644 "$token_file"
touch /vault/token/ready
echo "vault: ready"
wait "$server"
