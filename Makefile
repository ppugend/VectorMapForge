.PHONY: desktop server down clean logs build-tilemaker status

TILEMAKER_DIR := tilemaker
TILEMAKER_REPO := https://github.com/ppugend/tilemaker.git
TILEMAKER_TAG := v3.1.0

# tilemaker 소스 준비 (없으면 클론, 있으면 fetch + checkout)
prepare-tilemaker:
	@if [ ! -d "$(TILEMAKER_DIR)" ]; then \
		echo "Cloning tilemaker repository..."; \
		git clone $(TILEMAKER_REPO) $(TILEMAKER_DIR); \
		cd $(TILEMAKER_DIR) && git checkout $(TILEMAKER_TAG); \
	else \
		echo "Updating tilemaker repository..."; \
		cd $(TILEMAKER_DIR) && \
		git fetch --tags && \
		git checkout $(TILEMAKER_TAG); \
	fi

# 데스크탑 모드: tilemaker 빌드 + 타일 서빙 (개발/빌드용)
desktop: prepare-tilemaker
	docker compose -f docker-compose.desktop.yml up -d

# 서버 모드: 타일 서빙만 (tilemaker 없음, 프로덕션용)
server:
	docker compose -f docker-compose.server.yml up -d

# 모든 서비스 정지
down:
	docker compose -f docker-compose.desktop.yml down
	docker compose -f docker-compose.server.yml down

# 완전 정리 (볼륨 포함)
clean:
	docker compose -f docker-compose.desktop.yml down -v
	docker compose -f docker-compose.server.yml down -v

# 로그 확인 (데스크탑)
logs:
	docker compose -f docker-compose.desktop.yml logs -f

# tilemaker 수동 빌드
build-tilemaker: prepare-tilemaker
	docker build -t tilemaker:local-$(TILEMAKER_TAG) ./tilemaker

# 상태 확인
status:
	@echo "Tilemaker directory:"
	@if [ -d "$(TILEMAKER_DIR)" ]; then \
		cd $(TILEMAKER_DIR) && echo "  Exists at commit: $$(git rev-parse --short HEAD)"; \
	else \
		echo "  Not found (will clone on next make desktop)"; \
	fi
	@echo ""
	@echo "Docker images:"
	@docker images tilemaker:local-* --format "  {{.Repository}}:{{.Tag}}" 2>/dev/null || echo "  No local tilemaker images"
