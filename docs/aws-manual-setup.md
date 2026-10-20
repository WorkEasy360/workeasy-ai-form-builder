# AWS setup by hand, in the console (OPS-03)

This creates, click by click, what the app needs on AWS besides the EC2 server and your database. It replaces step 1 of [aws-deployment.md](aws-deployment.md); continue there with step 2 afterwards.

Do everything in **the region of your Aurora/RDS cluster**. You need your **account ID** (top-right menu in the console, 12 digits) and the **region code** (for example `ap-south-1`).

The JSON to paste is in [`infra/aws/iam/`](../infra/aws/iam/). Before pasting, replace the placeholders:

| Placeholder | Replace with |
|---|---|
| `ACCOUNT_ID` | your 12-digit account ID |
| `REGION` | the region code, e.g. `ap-south-1` |
| `QUARANTINE_BUCKET`, `FILES_BUCKET`, `EXPORTS_BUCKET`, `LEDGER_BUCKET`, `RELEASES_BUCKET` | the bucket names you create in step 2 |
| `GITHUB_OWNER/GITHUB_REPO` | your repository, e.g. `acme/workeasy-forms` |
| `FORMS_DOMAIN` | your public forms address, e.g. `forms.example.com` |

Write down every name as you go; step 7 lists what goes where.

## 1. Image repository (ECR)

**Amazon ECR → Private registry → Repositories → Create repository**

- Repository name: `workeasy-forms`
- Image tag mutability: **Immutable**
- Encryption: AES-256 (default)
- After creating: **Actions → Edit** (or Image scanning settings) → turn on **Scan on push**.
- Optional: **Lifecycle policy → Create rule**: "Image count more than 30", expire. Keeps storage small.

Note the repository **URI**, e.g. `123456789012.dkr.ecr.ap-south-1.amazonaws.com/workeasy-forms`.

## 2. Five private S3 buckets

**Amazon S3 → Create bucket**, five times. Bucket names are global, so prefix them with something of yours, e.g. `acme-workeasy-forms-…`.

For **every** bucket keep the defaults: *ACLs disabled*, **Block all public access: on**, *Server-side encryption with Amazon S3 managed keys (SSE-S3)*. Then, in each bucket, **Permissions → Bucket policy → Edit**, paste [`tls-only-bucket-policy.json`](../infra/aws/iam/tls-only-bucket-policy.json) with `BUCKET_NAME` replaced by that bucket's name (refuses unencrypted connections).

| Bucket (suggested name) | Purpose | Extra settings |
|---|---|---|
| `acme-workeasy-forms-quarantine` | Uploads waiting for the virus scan | **Permissions → CORS → Edit**: paste [`quarantine-cors.json`](../infra/aws/iam/quarantine-cors.json) with your forms domain. **Management → Lifecycle rule**: apply to all objects, *Expire current versions* after **2** days, *Delete incomplete multipart uploads* after **1** day. |
| `acme-workeasy-forms-files` | Scanned files of responses | **Properties → Bucket Versioning: Enable**. **Lifecycle rule**: *Permanently delete noncurrent versions* after **14** days, and *Delete expired object delete markers*. |
| `acme-workeasy-forms-exports` | Response exports (CSV) | **Lifecycle rule**: *Expire current versions* after **3** days. |
| `acme-workeasy-forms-deletion-ledger` | Record of deletions, replayed after a database restore | **Versioning: Enable**. **Lifecycle rule**: expire current versions after **400** days, delete noncurrent versions after **400** days. |
| `acme-workeasy-forms-releases` | Server files for each deploy | **Lifecycle rule**: expire current versions after **90** days. |

## 3. The settings secret (Secrets Manager)

**Secrets Manager → Store a new secret**

- Secret type: **Other type of secret** → **Plaintext** tab → for now type just `pending` (you'll paste the real settings later, see [aws-deployment.md](aws-deployment.md) step 5).
- Encryption key: `aws/secretsmanager` (default).
- Secret name: **`workeasy-forms/production/env`** (exactly this; the server's permissions expect it).
- No rotation.

Note the secret's **ARN** (on the secret's page).

## 4. Role for the EC2 server

**IAM → Roles → Create role**

1. Trusted entity: **AWS service** → Use case **EC2** → Next.
2. Permissions: search and tick **`AmazonSSMManagedInstanceCore`** → Next.
3. Role name: **`workeasy-forms-instance`** → Create role.
4. Open the role → **Add permissions → Create inline policy** → **JSON** → paste [`instance-policy.json`](../infra/aws/iam/instance-policy.json) with the placeholders replaced → Policy name `workeasy-forms-app` → Create.

The console also creates an **instance profile** with the same name; that is what you pick when launching the EC2 server (Advanced details → IAM instance profile), or attach later with *Actions → Security → Modify IAM role*.

## 5. Let GitHub Actions sign in (OpenID Connect)

**IAM → Identity providers.** If `token.actions.githubusercontent.com` is already listed, skip to step 6. Otherwise **Add provider**:

- Provider type: **OpenID Connect**
- Provider URL: `https://token.actions.githubusercontent.com`
- Audience: `sts.amazonaws.com`
- Add provider.

## 6. Role GitHub Actions deploys with

**IAM → Roles → Create role**

1. Trusted entity: **Custom trust policy** → paste [`deploy-trust.json`](../infra/aws/iam/deploy-trust.json) with `ACCOUNT_ID` and `GITHUB_OWNER/GITHUB_REPO` replaced. Only workflows on the `main` branch of that repository can use the role. → Next.
2. Skip adding managed permissions → Next.
3. Role name: **`workeasy-forms-github-deploy`** → Create role.
4. Open the role → **Add permissions → Create inline policy** → **JSON** → paste [`deploy-policy.json`](../infra/aws/iam/deploy-policy.json) with the placeholders replaced → Policy name `workeasy-forms-deploy` → Create.

Note the role's **ARN**, e.g. `arn:aws:iam::123456789012:role/workeasy-forms-github-deploy`.

## 7. What you noted, and where it goes

| Value | Used in |
|---|---|
| ECR repository URI | GitHub variable `AWS_ECR_REPOSITORY` |
| Releases bucket name | GitHub variable `AWS_RELEASES_BUCKET` |
| Secret ARN | GitHub variable `AWS_SETTINGS_SECRET_ID` |
| Deploy role ARN | GitHub variable `AWS_DEPLOY_ROLE_ARN` |
| Region code | GitHub variable `AWS_REGION`, and `OBJECT_STORAGE_REGION` in the settings |
| Quarantine, files, exports, ledger bucket names | The settings: `OBJECT_STORAGE_BUCKET_QUARANTINE`, `OBJECT_STORAGE_BUCKET_CLEAN`, `OBJECT_STORAGE_BUCKET_EXPORTS`, `DELETION_LEDGER_BUCKET` |
| `workeasy-forms-instance` | The EC2 server's IAM instance profile |

Now continue with [aws-deployment.md](aws-deployment.md), **step 2: Launch the EC2 server**.
