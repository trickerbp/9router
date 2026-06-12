# Setup, Build, and VPS Deployment Guide

This guide explains how to clone 9Router, build it locally, make code changes safely, and deploy it to a VPS with Docker.

## Security Rules

Never commit secrets or runtime state. Keep these files local only:

- `.env`, `.env.local`, and any other `.env*` file except `.env.example`
- OAuth exports such as `kiro-durable-*.json`
- SQLite databases such as `data.sqlite`, `*.sqlite-shm`, `*.sqlite-wal`
- VPS helper scripts that embed hostnames, passwords, or tokens
- Playwright/MCP logs and generated screenshots

Use environment variables, a server-side env file, or a secret manager for deployment values. Prefer SSH keys over passwords for VPS access.

## Requirements

- Node.js 22 or newer is recommended
- npm 10 or newer
- Docker on the VPS
- Git
- Optional for local CLI packaging: a terminal with permission to install global npm packages

## Clone and Run Locally

```bash
git clone https://github.com/trickerbp/9router.git
cd 9router
npm install
npm run dev
```

The local dev server uses port `8080` by default.

```bash
curl http://127.0.0.1:8080/api/health
```

Expected response:

```json
{"ok":true}
```

## Production Build

```bash
npm install
npm run build
npm start
```

If the clone does not include `package-lock.json`, use `npm install` rather than `npm ci`.

## Build the Global CLI Package

The CLI package lives in `cli/`. Use this when you need the desktop/tray/global `9router` command to include your latest app changes.

```bash
cd cli
npm install
npm run build
npm install -g . --force
```

On Windows, the global command usually resolves to:

```text
%APPDATA%\npm\9router.cmd
```

Start a local CLI instance:

```bash
9router --tray --skip-update -p 20128
```

Health check:

```bash
curl http://127.0.0.1:20128/api/health
```

## Coding Workflow

1. Create or update code in the app source, not inside generated folders such as `.next`, `.next-cli-build`, or `cli/app`.
2. Add tests for region routing, token refresh, fallback, or any shared provider behavior.
3. Run focused tests first, then build.

Example:

```bash
npx vitest run tests/unit/kiro-region.test.js tests/unit/kiro-model-slots.test.js
npm run build
```

If you changed the CLI bundle behavior, also run:

```bash
cd cli
npm run build
```

## Kiro Region Notes

Kiro has two different regions:

- OIDC / AWS IAM Identity Center token refresh: usually `us-east-1`
- Kiro Q / CodeWhisperer runtime and quota APIs: for EU workspaces, use `eu-central-1`

For imported durable JSON, keep both values:

```json
{
  "region": "eu-central-1",
  "oidc_region": "us-east-1",
  "profile_arn": "arn:aws:codewhisperer:eu-central-1:..."
}
```

Do not commit durable JSON files. Import them through the dashboard or a protected local API call only.

## VPS Deployment With Docker

These commands assume the VPS already has Docker installed and exposes the app on host port `9090`.

### 1. Prepare the VPS Directory

```bash
ssh root@YOUR_VPS_HOST
mkdir -p /opt/9router-deploy/backups
exit
```

### 2. Create a Clean Source Archive Locally

From the repo root:

```bash
tar -czf 9router-deploy.tgz \
  --exclude='.git' \
  --exclude='node_modules' \
  --exclude='.next' \
  --exclude='.next-cli-build' \
  --exclude='.env' \
  --exclude='.env.*' \
  --exclude='.playwright-mcp' \
  --exclude='data' \
  --exclude='logs' \
  .
```

Upload it:

```bash
scp 9router-deploy.tgz root@YOUR_VPS_HOST:/opt/9router-deploy/9router-deploy.tgz
```

### 3. Build the Docker Image on the VPS

```bash
ssh root@YOUR_VPS_HOST
cd /opt/9router-deploy
rm -rf src
mkdir src
tar -xzf 9router-deploy.tgz -C src

IMAGE_TAG=9router:deploy-$(date +%Y%m%d%H%M%S)
docker build --progress=plain -t "$IMAGE_TAG" src
echo "$IMAGE_TAG" > /opt/9router-deploy/image_tag_current
```

If the VPS runs out of disk space, check Docker usage:

```bash
df -h /
docker system df
docker builder prune -af
```

Do not remove the currently running image unless you have a rollback image or volume backup.

### 4. Preserve Environment and Backup Data

If a `9router` container already exists:

```bash
docker inspect 9router --format '{{range .Config.Env}}{{println .}}{{end}}' > /opt/9router-deploy/9router.env

OLD_IMAGE=$(docker inspect -f '{{.Image}}' 9router)
docker tag "$OLD_IMAGE" 9router:rollback-before-deploy

BACKUP=/opt/9router-deploy/backups/9router-data-$(date +%Y%m%d%H%M%S).tgz
tar -czf "$BACKUP" -C /var/lib/docker/volumes/9router-data/_data .
```

For a first deployment, create `/opt/9router-deploy/9router.env` manually and put only non-committed runtime variables there.

### 5. Start the New Container

```bash
IMAGE_TAG=$(cat /opt/9router-deploy/image_tag_current)

docker rm -f 9router 2>/dev/null || true
docker run -d \
  --name 9router \
  --restart unless-stopped \
  -p 9090:8080 \
  --env-file /opt/9router-deploy/9router.env \
  -v 9router-data:/app/data \
  "$IMAGE_TAG"

docker tag "$IMAGE_TAG" 9router:latest
```

### 6. Verify Deployment

```bash
curl -fsS http://127.0.0.1:9090/api/health
docker ps --filter name=9router --format '{{.Names}} {{.Image}} {{.Status}} {{.Ports}}'
docker logs --tail 120 9router
```

Expected health response:

```json
{"ok":true}
```

### 7. Roll Back If Needed

```bash
docker rm -f 9router
docker run -d \
  --name 9router \
  --restart unless-stopped \
  -p 9090:8080 \
  --env-file /opt/9router-deploy/9router.env \
  -v 9router-data:/app/data \
  9router:rollback-before-deploy
```

Restore a volume backup only if the data itself is bad:

```bash
docker rm -f 9router
tar -xzf /opt/9router-deploy/backups/YOUR_BACKUP.tgz -C /var/lib/docker/volumes/9router-data/_data
```

Then start the rollback container again.

## Importing Kiro Credentials After Deployment

Use the dashboard import flow when possible. It accepts either a plain refresh token or a durable JSON export.

If you use an API call, send the JSON only from a trusted machine and never print the token in logs:

```bash
curl -sS -X POST http://127.0.0.1:9090/api/oauth/kiro/import \
  -H 'Content-Type: application/json' \
  -H 'x-9r-cli-token: YOUR_LOCAL_CLI_TOKEN' \
  --data-binary @kiro-durable.json
```

Remove the uploaded token file immediately after import:

```bash
rm -f kiro-durable.json
```

## Git Push Checklist

Before pushing:

```bash
git status --short
git diff --cached --name-only
git diff --cached --check
```

Confirm that no secret file is staged. Then push to `main`:

```bash
git push origin HEAD:main
```
