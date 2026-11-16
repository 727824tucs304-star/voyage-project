#!/bin/sh
# Runs once on first start of the Postgres container.
# Creates the provisioner role used by the control plane (no superuser rights)
# and the central control database it owns.
set -e
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres <<EOSQL
CREATE ROLE voyage_provisioner LOGIN CREATEDB CREATEROLE PASSWORD '$PROVISIONER_PASSWORD';
CREATE DATABASE voyage_control OWNER voyage_provisioner;
EOSQL
