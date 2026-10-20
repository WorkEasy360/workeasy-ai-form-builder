#!/bin/bash
# EC2 user data for Workeasy Forms (OPS-03): paste into "Advanced details ->
# User data" when launching an Amazon Linux 2023 instance. Installs Docker and
# the Compose plugin; the Systems Manager agent and the AWS CLI are already on
# Amazon Linux 2023. Deploys then arrive from GitHub Actions.
set -euxo pipefail

dnf install -y docker
systemctl enable --now docker

# Docker Compose v2 plugin (not packaged for Amazon Linux 2023).
COMPOSE_VERSION=v2.32.4
arch=$(uname -m)
mkdir -p /usr/local/lib/docker/cli-plugins
curl -fsSL "https://github.com/docker/compose/releases/download/${COMPOSE_VERSION}/docker-compose-linux-${arch}" \
  -o /usr/local/lib/docker/cli-plugins/docker-compose
chmod 755 /usr/local/lib/docker/cli-plugins/docker-compose
docker compose version

mkdir -p /opt/workeasy-forms
chmod 700 /opt/workeasy-forms
