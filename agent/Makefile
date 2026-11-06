VERSION ?= $(shell git describe --tags --always --dirty 2>/dev/null || echo dev)
LDFLAGS := -s -w -X main.version=$(VERSION)
OUT ?= dist
# Подпись релиза (нужна для обновления агентов по кнопке). Приватный ключ хранится у вас, не в панели:
#   make keygen                         # один раз; release.pub закоммитьте, release.key — нет
#   make dist VERSION=0.3.0 SIGNING_KEY=release.key
SIGNING_KEY ?=
SIGNING_PUB ?= release.pub

.PHONY: test dist keygen clean
test:
	go vet ./... && go test -race ./...

keygen:
	go run ./cmd/popug-release keygen -key release.key -pub release.pub

# Статические бинарники для мостов (CGO выключен). С SIGNING_KEY рядом кладутся подписи и update.pub.
dist:
	mkdir -p $(OUT)
	CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags "$(LDFLAGS)" -o $(OUT)/popug-agent-linux-amd64 ./cmd/popug-agent
	CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build -trimpath -ldflags "$(LDFLAGS)" -o $(OUT)/popug-agent-linux-arm64 ./cmd/popug-agent
	echo "$(VERSION)" > $(OUT)/VERSION
	cd $(OUT) && sha256sum popug-agent-linux-amd64 popug-agent-linux-arm64 > SHA256SUMS
	@if [ -n "$(SIGNING_KEY)" ]; then \
	  for a in amd64 arm64; do go run ./cmd/popug-release sign -key $(SIGNING_KEY) -version $(VERSION) -arch $$a -o $(OUT)/popug-agent-linux-$$a.sig $(OUT)/popug-agent-linux-$$a || exit 1; done; \
	  cp $(SIGNING_PUB) $(OUT)/update.pub; \
	else echo "без SIGNING_KEY: релиз не подписан, обновление агентов по кнопке работать не будет"; fi

clean:
	rm -rf $(OUT)
