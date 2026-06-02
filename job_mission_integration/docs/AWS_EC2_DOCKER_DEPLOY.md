# AWS EC2 Docker 데모 배포 가이드

이 문서는 JOBSIM 데모를 AWS EC2 인스턴스 1대에 Docker Compose로 배포하는 절차를 정리한 가이드입니다.

## 1. EC2 인스턴스 준비

데모용 권장 설정은 다음과 같습니다.

- AMI: Ubuntu Server 24.04 LTS 또는 22.04 LTS
- 인스턴스 유형: `t3.small` 이상
- 스토리지: 12 GiB 이상, 여유 있게 운영하려면 20 GiB 이상
- 보안 그룹 인바운드 규칙:
  - SSH `22`: 본인 IP 또는 EC2 Instance Connect 허용
  - TCP `8080`: 데모 웹 접속용으로 전체 허용
  - HTTP `80`: `JOBSIM_HOST_PORT=80`으로 운영할 때만 선택적으로 허용

## 2. Docker 설치

EC2 인스턴스에 접속한 뒤 Docker Engine과 Docker Compose 플러그인을 설치합니다.

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

## 3. 배포 브랜치 내려받기

처음 배포하는 경우:

```bash
git clone <repo-url>
cd midas3
git switch deploy/aws-ec2-docker-demo
cd job_mission_integration
```

이미 EC2 서버에 저장소가 있는 경우:

```bash
cd midas3
git fetch origin
git switch deploy/aws-ec2-docker-demo
git pull --ff-only origin deploy/aws-ec2-docker-demo
cd job_mission_integration
```

## 4. 필수 데이터 확인

Docker Compose는 EC2 파일시스템의 폴더를 컨테이너에 연결해서 사용합니다. 따라서 아래 데이터가 EC2에 존재해야 합니다.

```bash
test -d data/api_raw
test -d data/additional_search
test -f missions/index.json
test -d missions/scenarios
mkdir -p outputs reports
```

`data/api_raw`와 `data/additional_search`는 읽기 전용으로 연결됩니다. `missions`, `outputs`, `reports`는 관리자 미션 생성 및 내보내기 과정에서 파일을 저장해야 하므로 쓰기 가능 상태로 연결됩니다.

## 5. 서버 환경변수 설정

```bash
cp .env.server.example .env.server
nano .env.server
```

최소한 아래 값은 설정해야 합니다.

```env
OPENAI_API_KEY=sk-...
OPENAI_GENERATION_MODEL=gpt-5.4-nano
OPENAI_EVAL_MODEL=gpt-4o-mini
ADMIN_PASSWORD=strong-demo-password
```

컨테이너 내부 서버는 `8080` 포트로 실행됩니다. EC2 호스트에서 다른 포트로 노출하고 싶다면 Docker Compose 실행 시 `JOBSIM_HOST_PORT`를 설정합니다.

## 6. 앱 실행

EC2 호스트의 `8080` 포트로 앱을 노출하는 기본 실행 방법입니다.

```bash
docker compose up -d --build
docker compose ps
docker compose logs -f jobsim
```

EC2 호스트의 `80` 포트로 노출하고 싶다면 다음처럼 실행합니다.

```bash
export JOBSIM_HOST_PORT=80
docker compose up -d --build
```

## 7. 동작 확인

EC2 서버 내부에서 확인합니다.

```bash
curl http://localhost:${JOBSIM_HOST_PORT:-8080}/health
curl http://localhost:${JOBSIM_HOST_PORT:-8080}/api/bootstrap
```

브라우저에서 확인합니다.

```text
사용자 페이지: http://<EC2_PUBLIC_IP>:8080/
관리자 페이지: http://<EC2_PUBLIC_IP>:8080/admin.html
```

호스트 포트를 `80`으로 사용 중이라면 다음 주소로 접속합니다.

```text
사용자 페이지: http://<EC2_PUBLIC_IP>/
관리자 페이지: http://<EC2_PUBLIC_IP>/admin.html
```

## 8. 데모 흐름

1. 관리자 페이지를 엽니다.
2. `ADMIN_PASSWORD`를 입력합니다.
3. 생성 가능한 직무와 난이도를 선택합니다.
4. 미션 생성을 실행합니다.
5. 생성 결과 미리보기를 확인합니다.
6. 내보내기 승인을 클릭합니다.
7. 사용자 페이지를 새로고침하고 새 미션이 카탈로그에 반영되었는지 확인합니다.

미션 생성 결과는 `outputs/pilot/v1/runs`에 저장됩니다. 내보내기 승인을 하면 `missions/index.json`과 `missions/scenarios/*.json`이 갱신됩니다.

## 9. 운영 명령어

로그 확인:

```bash
docker compose logs -f jobsim
```

컨테이너 재시작:

```bash
docker compose restart jobsim
```

배포 업데이트:

```bash
cd ~/midas3
git fetch origin
git switch deploy/aws-ec2-docker-demo
git reset --hard origin/deploy/aws-ec2-docker-demo
cd job_mission_integration
docker compose up -d --build
```

데모 데이터 백업:

```bash
tar -czf jobsim-demo-data-$(date +%Y%m%d-%H%M%S).tgz missions outputs reports
```

미션 데이터만 백업:

```bash
mkdir -p ~/midas-backups
tar -czf ~/midas-backups/missions-demo-baseline.tar.gz missions
```

미션 데이터 복원:

```bash
rm -rf missions
tar -xzf ~/midas-backups/missions-demo-baseline.tar.gz
docker compose restart
```
