# Deploying on AWS (OPS-03)

Production runs on one EC2 server. The database is your existing Aurora/RDS PostgreSQL cluster, files live in Amazon S3, and email goes through Amazon SES. Every push to `main` that passes CI is deployed automatically by GitHub Actions.

```
Browsers ── 443 ──> EC2 (Caddy: HTTPS) ──> console, forms, API, worker, malware scanner
                          │                         │
                          │                         ├── Aurora/RDS: database "workeasy_forms" (TLS, verified)
                          │                         ├── S3: uploads, files, exports, deletion ledger
                          │                         └── SES (SMTP): notification and confirmation email
Browsers ── presigned HTTPS ──────────────────────────> S3 (uploads and downloads)

GitHub push to main → CI passes → "Deploy to AWS" workflow:
  build image → ECR → release files → S3 → Systems Manager runs deploy.sh on the server
```

## What is isolated from your other data

| Layer | How |
|---|---|
| Database | A separate database, `workeasy_forms`, on your cluster. `CONNECT` is revoked from `PUBLIC`: only the app's four roles (and your master user) can connect. PostgreSQL has no cross-database queries. |
| Roles | `workeasy_owner`, `workeasy_api`, `workeasy_worker`, `workeasy_public`: no superuser, no replication, no bypassing row security, cannot create roles or databases. They hold no privileges in your other databases. |
| Inside the database | Every tenant table has forced row-level security; each request sees one organization only. |
| Network | Connections use TLS with the server certificate verified against Amazon's RDS certificate authorities (`sslmode=verify-full`). |
| Files | Dedicated private S3 buckets, encrypted, TLS-only, reachable only by the server's IAM role and short-lived presigned links. |

**Recommended on your side:** if your other databases still grant `CONNECT` to `PUBLIC` (the PostgreSQL default), revoke it there too (`REVOKE CONNECT ON DATABASE other_db FROM PUBLIC`), so the app's roles cannot even open a connection to them.

The app needs PostgreSQL 13 or later. On versions before 18 it adds its own `uuidv7()` function (tested on 17).

## One-time setup

### 1. Create the AWS resources

In CloudFormation, create a stack from [`infra/aws/cloudformation.yml`](../infra/aws/cloudformation.yml) in the region of your database. Parameters:

| Parameter | Value |
|---|---|
| `GitHubRepository` | `owner/repo-name` of this repository |
| `FormsOrigin` | `https://` + your forms domain, e.g. `https://forms.example.com` |
| `CreateGitHubOidcProvider` | `false` if your account already trusts GitHub Actions (IAM → Identity providers lists `token.actions.githubusercontent.com`) |

It creates the image repository, five S3 buckets, the settings secret, the server's IAM role and instance profile, and the role GitHub deploys with. Note the stack's **Outputs**; you need them below.

### 2. Launch the EC2 server

- **AMI:** Amazon Linux 2023. **Type:** `t3.large` or larger (the malware scanner needs about 1.5 GB of memory).
- **VPC/subnet:** one that can reach your database; a public subnet with an **Elastic IP**.
- **IAM instance profile:** the stack's `InstanceProfileName`.
- **Tag:** `workeasy-forms` = `production` (deploys target this tag).
- **Security group:** inbound 80 and 443 from anywhere. No SSH is needed: use Systems Manager Session Manager to get a shell.
- **User data:** the contents of [`infra/aws/ec2-user-data.sh`](../infra/aws/ec2-user-data.sh).
- **Disk:** 30 GB gp3.

In the **database's** security group, allow inbound 5432 from the server's security group.

### 3. DNS

Create A records for your two addresses (for example `forms-admin.example.com` for the console and `forms.example.com` for public forms) pointing at the Elastic IP. Caddy gets certificates automatically on the first deploy.

### 4. Amazon SES

1. SES → Identities: verify your sending domain (add the DKIM records it shows).
2. Request production access, or SES only delivers to verified addresses.
3. SES → SMTP settings → Create SMTP credentials. Keep the username and password for the settings below.

### 5. The settings secret

1. Copy [`infra/aws/env.example`](../infra/aws/env.example) and fill it in: domains, cluster endpoint, bucket names (stack outputs), your identity provider, SES SMTP credentials and region.
2. Run `infra/aws/new-secrets.sh` for the four database passwords, `SESSION_SECRET` and `INTEGRATION_SECRET_KEY`.
3. For the first deploy, set `DATABASE_ADMIN_URL` to your cluster's master user. The first deploy creates the `workeasy_forms` database and the four roles with it. Without it, a DBA can create them with the same names and passwords instead.
4. Paste the whole file as the value of the secret in the stack's `SettingsSecretArn` (Secrets Manager → Retrieve secret value → Edit → Plaintext). **Never commit it or send it in chat.**

### 6. GitHub

Settings → Secrets and variables → Actions → **Variables** (these are not secret):

| Variable | Value |
|---|---|
| `AWS_REGION` | e.g. `eu-west-1` |
| `AWS_DEPLOY_ROLE_ARN` | stack output `DeployRoleArn` |
| `AWS_ECR_REPOSITORY` | stack output `ImageRepository` |
| `AWS_RELEASES_BUCKET` | stack output `ReleasesBucketName` |
| `AWS_SETTINGS_SECRET_ID` | stack output `SettingsSecretArn` |

### 7. First deploy

Actions → **Deploy to AWS** → Run workflow (on `main`). It builds the image, pushes it to ECR, and runs the deploy on the server; the job log shows the server's output. Then:

- Open `https://<console domain>` and sign in.
- **Remove `DATABASE_ADMIN_URL` from the secret.** Later deploys only migrate, as the app's owner role.

From now on every push to `main` that passes CI deploys by itself.

## What a deploy does

On the server, `deploy.sh`:

1. Writes `.env` from the settings secret (mode 600) and fetches Amazon's RDS certificate bundle once.
2. Logs in to ECR with the instance role and pulls the new image.
3. Runs `db deploy`: creates the database and roles if `DATABASE_ADMIN_URL` is set, then applies migrations.
4. Starts the new version and waits up to 5 minutes for every health check.
5. If any check fails, restarts the previous release and fails the GitHub job.

Migrations are forward-only and must keep the previous release working (expand, then contract later), so an application rollback is always safe.

## Operating it

Get a shell with **Systems Manager → Session Manager → Start session** (no SSH key), then:

```sh
sudo -i
cd /opt/workeasy-forms
export WORKEASY_IMAGE=$(grep ' deployed ' releases.log | tail -n 1 | awk '{print $3}')   # the running release
```

| Task | Command |
|---|---|
| Releases and health | `AWS_REGION=eu-west-1 ./deploy.sh --status` |
| Roll back | `AWS_REGION=eu-west-1 SETTINGS_SECRET_ID=<arn> ./deploy.sh --rollback` |
| Logs | `docker compose --env-file .env logs --since 1h api worker` |

Change a setting: edit the secret, then re-run the workflow (or push). The runbook for failures is [operations.md](operations.md).

## Backups and restore

| Data | Protection |
|---|---|
| Database | Your cluster's automated backups and point-in-time restore (set retention ≥ 7 days) |
| Deletion ledger | Written to the ledger bucket by the worker every minute (versioned, kept 400 days) |
| Files | S3 (eleven nines durability); versioning keeps deleted files 14 days, then they are gone |

The cluster also holds other applications' data, so **never restore the whole production cluster** for this app. Instead:

1. Restore the cluster to a point in time as a **new, temporary** cluster.
2. Copy only this app's database out of it: `pg_dump -Fc -d workeasy_forms` from the temporary cluster, `pg_restore` into a new database (for example `workeasy_forms_restored`) on the production cluster.
3. Replay the ledger, so nothing deleted after the restore point comes back. On the server, in the shell set up under "Operating it":
   ```sh
   aws s3 sync s3://<ledger bucket>/deletion-ledger ./ledger
   cat ledger/*/*/*/*.jsonl | sort -u | docker compose --env-file .env --profile migrate run --rm -T \
     -e DATABASE_MIGRATION_URL='<owner URL, with database workeasy_forms_restored>' migrate ./node_modules/.bin/tsx src/cli.ts ledger-replay
   ```
4. In a short maintenance window, stop the app (`docker compose stop`), swap the databases (`ALTER DATABASE ... RENAME TO ...`, as the master user), start the worker first so it purges replayed deletions, then everything else.
5. Delete the temporary cluster.

## Costs, roughly (eu-west-1)

`t3.large` around 60 USD a month; S3, ECR, Secrets Manager and SES a few dollars at modest volume; the database is your existing cluster.
