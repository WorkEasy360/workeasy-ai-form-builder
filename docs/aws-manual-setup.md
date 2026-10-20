# AWS setup by hand, in the console (OPS-03)

Three things to create besides the EC2 server and your database: four S3 buckets, one secret, and the server's IAM role. About 10 minutes. This is step 1 of [aws-deployment.md](aws-deployment.md); continue there afterwards.

Create them in **the server's region** (`ap-southeast-1`, Singapore), next to the EC2 server. Only the database stays in its own region.

The JSON to paste is in [`infra/aws/iam/`](../infra/aws/iam/). Before pasting, replace the placeholders:

| Placeholder | Replace with |
|---|---|
| `ACCOUNT_ID` | your 12-digit account ID (top-right menu in the console) |
| `REGION` | `ap-southeast-1` |
| `QUARANTINE_BUCKET`, `FILES_BUCKET`, `EXPORTS_BUCKET`, `LEDGER_BUCKET` | the bucket names you create in step 1 |
| `FORMS_DOMAIN` | your public forms address, e.g. `forms.example.com` |

## 1. Four private S3 buckets

**Amazon S3 → Create bucket**, four times. Bucket names are global, so prefix them with something of yours, e.g. `acme-workeasy-forms-…`.

For **every** bucket keep the defaults: *ACLs disabled*, **Block all public access: on**, *Server-side encryption with Amazon S3 managed keys (SSE-S3)*. Then, in each bucket, **Permissions → Bucket policy → Edit**, paste [`tls-only-bucket-policy.json`](../infra/aws/iam/tls-only-bucket-policy.json) with `BUCKET_NAME` replaced by that bucket's name (refuses unencrypted connections).

| Bucket (suggested name) | Purpose | Extra settings |
|---|---|---|
| `acme-workeasy-forms-quarantine` | Uploads waiting for the virus scan | **Permissions → CORS → Edit**: paste [`quarantine-cors.json`](../infra/aws/iam/quarantine-cors.json) with your forms domain. **Management → Create lifecycle rule**: apply to all objects; *Expire current versions* after **2** days; *Delete incomplete multipart uploads* after **1** day. |
| `acme-workeasy-forms-files` | Scanned files of responses | **Properties → Bucket Versioning: Enable**. **Lifecycle rule**: *Permanently delete noncurrent versions* after **14** days, and *Delete expired object delete markers*. |
| `acme-workeasy-forms-exports` | Response exports (CSV) | **Lifecycle rule**: *Expire current versions* after **3** days. |
| `acme-workeasy-forms-deletion-ledger` | Record of deletions, replayed after a database restore | **Versioning: Enable**. **Lifecycle rule**: expire current versions after **400** days; delete noncurrent versions after **400** days. |

## 2. The settings secret (Secrets Manager)

**Secrets Manager → Store a new secret**

- Secret type: **Other type of secret** → **Plaintext** tab → for now type just `pending` (the real settings come later, [aws-deployment.md](aws-deployment.md) step 5).
- Encryption key: `aws/secretsmanager` (default).
- Secret name: **`workeasy-forms/production/env`**, exactly; the server looks for this name.
- No rotation.

## 3. Role for the EC2 server

**IAM → Roles → Create role**

1. Trusted entity: **AWS service** → Use case **EC2** → Next.
2. Permissions: optional but handy, tick **`AmazonSSMManagedInstanceCore`**: it lets you open a shell from the console (Session Manager) without SSH. → Next.
3. Role name: **`workeasy-forms-instance`** → Create role.
4. Open the role → **Add permissions → Create inline policy** → **JSON** → paste [`instance-policy.json`](../infra/aws/iam/instance-policy.json) with the placeholders replaced → Policy name `workeasy-forms-app` → Create.

It lets the server use the four buckets and read the settings secret, nothing else. Attach it to the server: **EC2 → Instances → your instance → Actions → Security → Modify IAM role** → `workeasy-forms-instance` → Update IAM role.

## What goes where

| Value | Used in the settings (step 5 of aws-deployment.md) |
|---|---|
| Quarantine bucket name | `OBJECT_STORAGE_BUCKET_QUARANTINE` |
| Files bucket name | `OBJECT_STORAGE_BUCKET_CLEAN` |
| Exports bucket name | `OBJECT_STORAGE_BUCKET_EXPORTS` |
| Deletion ledger bucket name | `DELETION_LEDGER_BUCKET` |
| `ap-southeast-1` | `OBJECT_STORAGE_REGION` |

Now continue with [aws-deployment.md](aws-deployment.md), **step 2**.
