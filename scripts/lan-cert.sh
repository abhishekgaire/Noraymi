#!/usr/bin/env bash
# Local only: the HTTPS certificate for the practice night from a laptop (scripts/demo-start.sh --lan).
#   scripts/lan-cert.sh <lan-ip> <out-dir>
# Makes, once, a small certificate authority of this laptop's own (kept in WEST4_LAN_CA_DIR, by default
# ~/Library/Application Support/West 4 practice CA, so each bar PC and phone trusts it only once), then
# a fresh server certificate for <lan-ip> and localhost into <out-dir>/cert.pem and key.pem.
# The CA is name-constrained to private addresses and localhost: even trusted, it can't vouch for any
# real website. Its key never leaves this laptop; only rootCA.pem is handed out.
# Uses the openssl that ships with macOS; nothing to install.
set -euo pipefail
ip=${1:?usage: lan-cert.sh <lan-ip> <out-dir>}
out=${2:?usage: lan-cert.sh <lan-ip> <out-dir>}
ca_dir=${WEST4_LAN_CA_DIR:-"$HOME/Library/Application Support/West 4 practice CA"}
mkdir -p "$ca_dir" "$out"
chmod 700 "$ca_dir"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

if [ ! -f "$ca_dir/rootCA.pem" ] || [ ! -f "$ca_dir/rootCA-key.pem" ]; then
  cat >"$tmp/ca.cnf" <<'CNF'
[req]
distinguished_name = dn
prompt = no
[dn]
CN = West 4 practice night CA
O = West 4 practice night (local only)
[v3_ca]
basicConstraints = critical, CA:TRUE, pathlen:0
keyUsage = critical, keyCertSign, cRLSign
subjectKeyIdentifier = hash
nameConstraints = critical, permitted;IP:10.0.0.0/255.0.0.0, permitted;IP:172.16.0.0/255.240.0.0, permitted;IP:192.168.0.0/255.255.0.0, permitted;IP:127.0.0.0/255.0.0.0, permitted;DNS:localhost
CNF
  (umask 077 && openssl genrsa -out "$ca_dir/rootCA-key.pem" 2048 2>/dev/null)
  openssl req -x509 -new -sha256 -days 3650 -key "$ca_dir/rootCA-key.pem" -config "$tmp/ca.cnf" \
    -extensions v3_ca -out "$ca_dir/rootCA.pem"
fi

# The server certificate: 397 days at most, which every browser accepts.
cat >"$tmp/leaf.cnf" <<CNF
basicConstraints = critical, CA:FALSE
keyUsage = critical, digitalSignature, keyEncipherment
extendedKeyUsage = serverAuth
subjectAltName = IP:$ip, IP:127.0.0.1, DNS:localhost
CNF
(umask 077 && openssl genrsa -out "$out/key.pem" 2048 2>/dev/null)
openssl req -new -sha256 -key "$out/key.pem" -subj "/CN=$ip" -out "$tmp/leaf.csr"
openssl x509 -req -sha256 -days 397 -in "$tmp/leaf.csr" -CA "$ca_dir/rootCA.pem" \
  -CAkey "$ca_dir/rootCA-key.pem" -set_serial "0x$(openssl rand -hex 16)" \
  -extfile "$tmp/leaf.cnf" -out "$out/cert.pem" 2>/dev/null
cp "$ca_dir/rootCA.pem" "$out/rootCA.pem"
openssl verify -CAfile "$out/rootCA.pem" "$out/cert.pem" >/dev/null
