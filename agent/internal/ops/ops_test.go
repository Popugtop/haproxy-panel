package ops

import (
	"time"

	"context"
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"popug-bridges/agent/internal/apply"
	"strings"
	"testing"

	"popug-bridges/agent/internal/proto"
)

func TestUnknownOpsRejected(t *testing.T) {
	d := New("/nonexistent")
	for _, op := range []string{"exec", "shell", "apply_config_raw", "rm -rf /", ""} {
		r := d.Handle(context.Background(), proto.Cmd{T: "cmd", ID: "1", Op: op})
		if r.OK || r.Error == nil || !strings.HasPrefix(*r.Error, "unsupported_op") {
			t.Errorf("op %q: %+v", op, r)
		}
	}
}

func TestSupportedOpsAreDispatched(t *testing.T) {
	d := New("/nonexistent")
	for _, op := range proto.SupportedOps {
		if _, ok := d.handlers[op]; !ok {
			t.Errorf("операция %s объявлена в hello, но не реализована", op)
		}
	}
	if len(d.handlers) != len(proto.SupportedOps) {
		t.Errorf("в диспетчере %d обработчиков, в SupportedOps %d", len(d.handlers), len(proto.SupportedOps))
	}
}

func TestGetConfigIgnoresArgsPath(t *testing.T) {
	dir := t.TempDir()
	cfg := filepath.Join(dir, "haproxy.cfg")
	body := "global\n    log /dev/log local0\n"
	os.WriteFile(cfg, []byte(body), 0o644)
	secret := filepath.Join(dir, "secret")
	os.WriteFile(secret, []byte("TOP SECRET"), 0o600)

	d := New(cfg)
	// Панель пытается подсунуть путь — он не должен читаться.
	r := d.Handle(context.Background(), proto.Cmd{T: "cmd", ID: "1", Op: proto.OpGetConfig, Args: []byte(`{"path":"` + secret + `"}`)})
	if !r.OK {
		t.Fatalf("%+v", r)
	}
	cd := r.Data.(proto.ConfigData)
	sum := sha256.Sum256([]byte(body))
	if cd.Content != body || cd.Path != cfg || cd.SHA256 != hex.EncodeToString(sum[:]) {
		t.Fatalf("%+v", cd)
	}
}

func TestGetConfigMissingFile(t *testing.T) {
	r := New("/definitely/missing.cfg").Handle(context.Background(), proto.Cmd{T: "cmd", ID: "2", Op: proto.OpGetConfig})
	if r.OK || r.Error == nil {
		t.Fatalf("%+v", r)
	}
}

func TestApplyAndChecksRequireConfiguredDeps(t *testing.T) {
	d := New("/x")
	for _, op := range []string{proto.OpApplyConfig, proto.OpRunChecks, proto.OpApplyBans, proto.OpGetClients, proto.OpUpdateAgent} {
		r := d.Handle(context.Background(), proto.Cmd{T: "cmd", ID: "1", Op: op, Args: []byte(`{}`)})
		if r.OK || r.Error == nil {
			t.Errorf("%s без зависимостей должен вернуть ошибку: %+v", op, r)
		}
	}
}

func TestApplyOnlyDeliversTextNotPaths(t *testing.T) {
	// Команда с путём в args: агент всё равно пишет только в свои фиксированные файлы.
	dir := t.TempDir()
	secret := filepath.Join(dir, "must-not-be-touched")
	os.WriteFile(secret, []byte("ORIGINAL"), 0o600)
	cfg := filepath.Join(dir, "haproxy.cfg")
	os.WriteFile(cfg, []byte("OLD"), 0o644)
	d := New(cfg)
	d.Applier = apply.New(cfg, filepath.Join(dir, "sni.map"), filepath.Join(dir, "bk"), okRunner{}, func(context.Context, time.Duration) error { return nil })
	args := `{"version":1,"cfg":"global\n","sniMap":"","path":"` + secret + `","cfgPath":"` + secret + `"}`
	r := d.Handle(context.Background(), proto.Cmd{T: "cmd", ID: "1", Op: proto.OpApplyConfig, Args: []byte(args)})
	if !r.OK {
		t.Fatalf("%+v", r)
	}
	if b, _ := os.ReadFile(secret); string(b) != "ORIGINAL" {
		t.Fatal("агент записал в путь из команды")
	}
	if b, _ := os.ReadFile(cfg); string(b) != "global\n" {
		t.Fatalf("конфиг не применён: %q", b)
	}
}

type okRunner struct{}

func (okRunner) Run(context.Context, string, ...string) ([]byte, error) { return nil, nil }

func TestPing(t *testing.T) {
	r := New("/x").Handle(context.Background(), proto.Cmd{T: "cmd", ID: "3", Op: proto.OpPing})
	if !r.OK || r.ID != "3" {
		t.Fatalf("%+v", r)
	}
}
