# AWS EC2 Docker Demo Deployment

This guide deploys the JOBSIM demo on one EC2 instance with Docker Compose.

## 1. EC2 Instance

Recommended demo settings:

- AMI: Ubuntu Server 24.04 LTS or 22.04 LTS
- Instance type: `t3.small` or larger
- Storage: 20 GB or larger
- Security group inbound rules:
  - SSH `22` from your IP only
  - TCP `8080` from anywhere for a quick demo
  - Optional HTTP `80` from anywhere if `JOBSIM_HOST_PORT=80`

## 2. Install Docker

Connect to the instance and install Docker Engine plus the Compose plugin.

```bash
sudo apt update
sudo apt install -y ca-certificates curl git
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
echo \
  "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu \
  $(. /etc/os-release && echo "${UBUNTU_CODENAME:-$VERSION_CODENAME}") stable" | \
  sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
sudo apt update
sudo apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo usermod -aG docker "$USER"
newgrp docker
docker --version
docker compose version
```

## 3. Clone The Deployment Branch

```bash
git clone <repo-url>
cd midas3
git switch deploy/aws-ec2-docker-demo
cd job_mission_integration
```

If the repository already exists on the server:

```bash
cd midas3
git fetch origin
git switch deploy/aws-ec2-docker-demo
git pull
cd job_mission_integration
```

## 4. Check Required Data

These folders must exist on the EC2 filesystem because Docker Compose mounts them into the container:

```bash
test -d data/api_raw
test -d data/additional_search
test -f missions/index.json
test -d missions/scenarios
mkdir -p outputs reports
```

`data/api_raw` and `data/additional_search` are mounted read-only. `missions`, `outputs`, and `reports` are writable so the admin generation flow can save and export missions.

## 5. Configure Server Secrets

```bash
cp .env.server.example .env.server
nano .env.server
```

Set at least:

```env
OPENAI_API_KEY=sk-...
OPENAI_EVAL_MODEL=gpt-4o-mini
ADMIN_PASSWORD=strong-demo-password
```

The container listens on internal port `8080`. To expose a different host port, set `JOBSIM_HOST_PORT` when running Compose.

## 6. Start The App

Expose port `8080` on the EC2 host:

```bash
docker compose up -d --build
docker compose ps
docker compose logs -f jobsim
```

Expose port `80` on the EC2 host:

```bash
export JOBSIM_HOST_PORT=80
docker compose up -d --build
```

## 7. Verify

From the EC2 host:

```bash
curl http://localhost:${JOBSIM_HOST_PORT:-8080}/health
curl http://localhost:${JOBSIM_HOST_PORT:-8080}/api/bootstrap
```

From a browser:

```text
User page:  http://<EC2_PUBLIC_IP>:8080/
Admin page: http://<EC2_PUBLIC_IP>:8080/admin.html
```

If using host port `80`:

```text
User page:  http://<EC2_PUBLIC_IP>/
Admin page: http://<EC2_PUBLIC_IP>/admin.html
```

## 8. Demo Flow

1. Open the admin page.
2. Enter `ADMIN_PASSWORD`.
3. Select an enabled job and difficulty.
4. Run mission generation.
5. Review the generated preview.
6. Click export approval.
7. Refresh the user page and confirm the new mission catalog is visible.

Mission generation writes to `outputs/pilot/v1/runs`. Export approval updates `missions/index.json` and `missions/scenarios/*.json`.

## 9. Operations

View logs:

```bash
docker compose logs -f jobsim
```

Restart:

```bash
docker compose restart jobsim
```

Update deployment:

```bash
git pull
docker compose up -d --build
```

Backup generated demo data:

```bash
tar -czf jobsim-demo-data-$(date +%Y%m%d-%H%M%S).tgz missions outputs reports
```
