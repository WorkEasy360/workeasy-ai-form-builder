# Deploying on AWS (OPS-03)

Production runs on one EC2 server in Singapore (`ap-southeast-1`). The database is your existing RDS PostgreSQL instance in Stockholm (`eu-north-1`), reached over the internet with TLS. Files live in Amazon S3 and email goes through Amazon SES, both in Singapore. Every push to `main` that passes CI is deployed automatically by GitHub Actions over SSH.

```
Browsers ── 443 ──> EC2, ap-southeast-1 (Caddy: HTTPS) ──> console, forms, API, worker, malware scanner
                                                     │
                                                     ├── RDS PostgreSQL, eu-north-1: database "workeasy_forms"
                                                     │     (internet, TLS verified, allowed from the Elastic IP only)
                                                     ├── S3, ap-southeast-1: uploads, files, exports, deletion ledger
                                                     └── SES SMTP, ap-southeast-1: notification and confirmation email
Browsers ── presigned HTTPS ─────────────────────────> S3 (uploads and downloads)

GitHub push to main → CI passes → "Deploy to AWS" workflow:
  build image → GitHub container registry → SSH to the server → deploy.sh
```

## What is isolated from your other data

| Layer | How |
|---|---|
| Database | A separate database, `workeasy_forms`, on your instance. `CONNECT` is revoked from `PUBLIC`: only the app's four roles (and your master user) can connect. PostgreSQL has no cross-database queries. |
| Roles | `workeasy_owner`, `workeasy_api`, `workeasy_worker`, `workeasy_public`: no superuser, no replication, no bypassing row security, cannot create roles or databases. They hold no privileges in your other databases. |
| Inside the database | Every tenant table has forced row-level security; each request sees one organization only. |
| Network | TLS with the server certificate verified against Amazon's RDS certificate authorities (`sslmode=verify-full`). The database's security group admits this app only from the server's Elastic IP. |
| Files | Dedicated private S3 buckets, encrypted, HTTPS only, reachable only by the server's IAM role and short-lived presigned links. |

**Recommended on your side:** if your other databases still grant `CONNECT` to `PUBLIC` (the PostgreSQL default), revoke it there too (`REVOKE CONNECT ON DATABASE other_db FROM PUBLIC`), so the app's roles cannot even open a connection to them. And if the database's security group allows 5432 from `0.0.0.0/0`, it is open to the whole internet, not just to this server.

The app needs PostgreSQL 13 or later. On versions before 18 it adds its own `uuidv7()` function (tested on 17).

### The cost of two regions

Every database query travels Singapore ↔ Stockholm (about 160–200 ms). A form submission makes about ten round trips, so it takes roughly 1.5–2 seconds, and one form can accept around 5 submissions per second. Moving the server (or the database) so both share a region removes this; nothing in the app depends on the regions.

## One-time setup

### 1. S3 buckets, the settings secret and the server's role

Follow [aws-manual-setup.md](aws-manual-setup.md) (about 10 minutes), in `ap-southeast-1`.

### 2. The EC2 server

Already launched, with Elastic IP `54.255.105.162`. Check that it has:

- **IAM instance profile:** `instanceRole` (Actions → Security → Modify IAM role).
- **Security group, inbound:** HTTP 80 and HTTPS 443 from `0.0.0.0/0` (Let's Encrypt and visitors), SSH 22 for GitHub Actions' deploys.
- **Docker and the AWS CLI:** the server runs **Ubuntu**: copy [`infra/aws/ec2-setup-ubuntu.sh`](../infra/aws/ec2-setup-ubuntu.sh) to it and run it once with `sudo bash ec2-setup-ubuntu.sh`. (On Amazon Linux 2023, use [`ec2-user-data.sh`](../infra/aws/ec2-user-data.sh) instead.)
- **Size:** `m7i-flex.large` (2 vCPU, 8 GB) or `t3.large`; the malware scanner alone needs about 1.5 GB of memory. 30 GB disk.

### 3. The database

In the RDS console, `projectmodule-test` → Connectivity & security:

- **Publicly accessible:** Yes.
- Its **VPC security group** → Edit inbound rules → add **PostgreSQL, 5432, source `54.255.105.162/32`**.

### 4. DNS

Two A records pointing at `54.255.105.162`, for example `forms-admin.example.com` (console) and `forms.example.com` (public forms). With Cloudflare, set them to **DNS only**. Caddy gets HTTPS certificates on the first deploy.

**No domain yet?** Use `forms-admin.54-255-105-162.sslip.io` (console) and `forms.54-255-105-162.sslip.io` (forms): sslip.io resolves them to the IP inside the name, and Caddy gets real certificates for them. Switching to your domain later only changes the settings (and the Cognito callback URLs).

### 4b. Sign-in

People sign up and sign in with **email and password** on the console's home page; nothing to set up. New users create their own organization on first sign-in and invite the rest from **Members**. Not yet included: email verification and "forgot password" (they need SES).

**Optional, single sign-on** (OpenID Connect, e.g. Amazon Cognito or your company's identity provider): the console offers "Sign in with single sign-on" only once the provider in `OIDC_ISSUER_URL` answers. With Cognito:

In **Amazon Cognito → User pools → Create user pool** (ap-southeast-1):

1. Application type **Traditional web application**, name `workeasy-forms`.
2. Sign-in identifiers: **Email**. Self-registration: **on**. Required attributes: `email`.
3. Return URL: `https://<console domain>/auth/callback` → Create.
4. Open the app client → **Login pages → Edit**: allowed callback URLs `https://<console domain>/auth/callback` **and** `https://<forms domain>/public/v1/auth/callback`; OAuth grant **Authorization code**; scopes `openid`, `email`, `profile`.
5. Settings: `OIDC_ISSUER_URL=https://cognito-idp.ap-southeast-1.amazonaws.com/<user pool ID>`, `OIDC_CLIENT_ID` and `OIDC_CLIENT_SECRET` from the app client.

Cognito sends the verification emails itself (up to 50 a day without SES; connect SES later for more).

### 5. Amazon SES (in ap-southeast-1)

1. SES → Identities: verify your sending domain (add the DKIM records it shows).
2. Request production access; otherwise SES only delivers to verified addresses.
3. SES → SMTP settings → Create SMTP credentials. Keep the username and password for the settings.

### 6. The settings

1. Copy [`infra/aws/env.example`](../infra/aws/env.example) and fill it in: the two domains, the bucket names, your identity provider, SES SMTP credentials (`SMTP_HOST=email-smtp.ap-southeast-1.amazonaws.com`), `OBJECT_STORAGE_REGION=ap-southeast-1`.
2. In every database URL use the Stockholm endpoint, e.g. `postgres://workeasy_api:PASSWORD@projectmodule-test.cvka262cqti8.eu-north-1.rds.amazonaws.com:5432/workeasy_forms?sslmode=verify-full&sslrootcert=/etc/ssl/rds/global-bundle.pem`.
3. Run `infra/aws/new-secrets.sh` for the four role passwords, `SESSION_SECRET` and `INTEGRATION_SECRET_KEY`.
4. For the first deploy, set `DATABASE_ADMIN_URL` to the instance's master user: the first deploy creates the `workeasy_forms` database and the four roles with it.
5. Paste the whole file as the value of the secret `workeasy-forms/production/env` (Secrets Manager → Retrieve secret value → Edit → Plaintext). **Never commit it or send it in chat.**

### 7. GitHub

Settings → Secrets and variables → Actions:

| Kind | Name | Value |
|---|---|---|
| Secret | `EC2_HOST` | `54.255.105.162` |
| Secret | `EC2_USER` | `ubuntu` (on Amazon Linux it would be `ec2-user`) |
| Secret | `EC2_SSH_KEY` | the private key (`.pem` file contents) of the instance's key pair |
| Secret, optional | `EC2_KNOWN_HOSTS` | output of `ssh-keyscan 54.255.105.162`, run from a machine you trust; pins the server's identity |
| Variable | `DOMAIN` | the console's domain, e.g. `forms-admin.example.com` (checked after each deploy) |

The app's passwords are not in GitHub; the server reads them from Secrets Manager with its IAM role.

### 8. First deploy

Actions → **Deploy to AWS** → Run workflow (on `main`). It builds the image, pushes it to GitHub's container registry, and runs the deploy on the server over SSH; the job log shows the server's output. Then:

- Open `https://<console domain>` and sign in.
- **Remove `DATABASE_ADMIN_URL` from the secret.** Later deploys only migrate, as the app's owner role.

From now on every push to `main` that passes CI deploys by itself.

## What a deploy does

On the server, `deploy.sh` (as root, in `/opt/workeasy-forms`):

1. Writes `.env` from the settings secret (mode 600) and fetches Amazon's RDS certificate bundle once.
2. Pulls the new image (the workflow has logged the server in to the registry for this job only).
3. Runs `db deploy`: creates the database and roles if `DATABASE_ADMIN_URL` is set, then applies migrations.
4. Starts the new version and waits up to 5 minutes for every health check.
5. If any check fails, restarts the previous release and fails the GitHub job.

Migrations are forward-only and must keep the previous release working (expand, then contract later), so an application rollback is always safe.

## Operating it

SSH in (or use Session Manager), then:

```sh
sudo -i
cd /opt/workeasy-forms
export WORKEASY_IMAGE=$(grep ' deployed ' releases.log | tail -n 1 | awk '{print $3}')   # the running release
```

| Task | Command |
|---|---|
| Releases and health | `./deploy.sh --status` |
| Roll back | `./deploy.sh --rollback` |
| Logs | `docker compose --env-file .env logs --since 1h api worker` |

Change a setting: edit the secret, then re-run the workflow (or push). The runbook for failures is [operations.md](operations.md).

## Backups and restore

| Data | Protection |
|---|---|
| Database | Your instance's automated backups and point-in-time restore (set retention ≥ 7 days) |
| Deletion ledger | Written to the ledger bucket by the worker every minute (versioned, kept 400 days) |
| Files | S3; versioning keeps deleted files 14 days, then they are gone |

The instance also holds other applications' data, so **never restore the production instance itself** for this app. Instead:

1. Restore the instance to a point in time as a **new, temporary** instance.
2. Copy only this app's database out of it: `pg_dump -Fc -d workeasy_forms` from the temporary instance, `pg_restore` into a new database (for example `workeasy_forms_restored`) on the production instance.
3. Replay the ledger, so nothing deleted after the restore point comes back. On the server, in the shell set up under "Operating it":
   ```sh
   aws s3 sync s3://<ledger bucket>/deletion-ledger ./ledger
   cat ledger/*/*/*/*.jsonl | sort -u | docker compose --env-file .env --profile migrate run --rm -T \
     -e DATABASE_MIGRATION_URL='<owner URL, with database workeasy_forms_restored>' migrate ./node_modules/.bin/tsx src/cli.ts ledger-replay
   ```
4. In a short maintenance window, stop the app (`docker compose stop`), swap the databases (`ALTER DATABASE ... RENAME TO ...`, as the master user), start the worker first so it purges replayed deletions, then everything else.
5. Delete the temporary instance.

The server's role can write to the ledger bucket but not read it; run step 3's `aws s3 sync` with credentials of your own (for example in CloudShell, then copy the files over), or add `s3:GetObject` and `s3:ListBucket` on the ledger bucket to the role for the duration of the restore.
