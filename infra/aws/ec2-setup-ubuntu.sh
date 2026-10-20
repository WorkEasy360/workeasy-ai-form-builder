#!/bin/bash
# One-time setup of an Ubuntu EC2 server for Workeasy Forms (OPS-03).
# Run once on the server: sudo bash ec2-setup-ubuntu.sh
# Installs Docker with the Compose plugin and the AWS CLI (deploy.sh reads the
# settings secret with it). Deploys then arrive from GitHub Actions over SSH.
set -euxo pipefail

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y ca-certificates curl unzip docker.io docker-compose-v2
systemctl enable --now docker
docker compose version

# AWS CLI v2 (the snap is maintained by AWS).
if ! command -v aws > /dev/null; then
  snap install aws-cli --classic
fi
aws --version

# The instance role must be attached for this to print the role's identity.
aws sts get-caller-identity || echo "No IAM role yet: attach workeasy-forms-instance (EC2 -> Actions -> Security -> Modify IAM role)."

install -d -m 700 /opt/workeasy-forms
