package apply

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"popug-bridges/agent/internal/proto"
)

type call struct{ name, args string }

type fakeRunner struct {
	calls       []call
	cfgPath     string
	haproxyFail func(cfg string) bool // haproxy -c
	reloadFail  func(cfg string) bool // systemctl reload
	inactive    bool
}

func (f *fakeRunner) Run(_ context.Context, name string, args ...string) ([]byte, error) {
	f.calls = append(f.calls, call{name, strings.Join(args, " ")})
	cfg, _ := os.ReadFile(f.cfgPath)
	switch {
	case name == "haproxy":
		// -c -f <tmp>: читаем кандидата
		b, _ := os.ReadFile(args[2])
		if f.haproxyFail != nil && f.haproxyFail(string(b)) {
			return []byte("[ALERT] parsing [haproxy.cfg:3]: unknown keyword 'foo' in 'global' section"), errors.New("exit 1")
		}
		return []byte("Configuration file is valid"), nil
	case name == "systemctl" && args[0] == "is-active":
		if f.inactive {
			return nil, errors.New("inactive")
		}
		return nil, nil
	case name == "systemctl" && (args[0] == "reload" || args[0] == "restart"):
		if f.reloadFail != nil && f.reloadFail(string(cfg)) {
			return []byte("Job for haproxy.service failed"), errors.New("exit 1")
		}
		return nil, nil
	}
	return nil, nil
}

type env struct {
	dir    string
	ap     *Applier
	fr     *fakeRunner
	clock  time.Time
	health func(cfg string) error
}

func newEnv(t *testing.T, oldCfg, oldMap string) *env {
	t.Helper()
	dir := t.TempDir()
	e := &env{dir: dir, clock: time.Unix(1_700_000_000, 0)}
	cfg := filepath.Join(dir, "haproxy.cfg")
	mp := filepath.Join(dir, "maps", "sni.map")
	if oldCfg != "" {
		os.WriteFile(cfg, []byte(oldCfg), 0o644)
	}
	if oldMap != "" {
		os.MkdirAll(filepath.Dir(mp), 0o755)
		os.WriteFile(mp, []byte(oldMap), 0o644)
	}
	e.fr = &fakeRunner{cfgPath: cfg}
	e.health = func(string) error { return nil }
	e.ap = New(cfg, mp, filepath.Join(dir, "backups"), e.fr, func(ctx context.Context, since time.Duration) error {
		b, _ := os.ReadFile(cfg)
		return e.health(string(b))
	})
	e.ap.Now = func() time.Time { return e.clock }
	e.ap.Sleep = func(d time.Duration) { e.clock = e.clock.Add(d) }
	return e
}

func (e *env) read(p string) string { b, _ := os.ReadFile(p); return string(b) }

func TestApplySuccess(t *testing.T) {
	e := newEnv(t, "OLD CFG\n", "old.example be_old\n")
	res, err := e.ap.Apply(context.Background(), proto.ApplyArgs{Version: 5, Cfg: "global\n    daemon\n", SniMap: "de.example be_de\n"})
	if err != nil || !res.Applied || res.RolledBack || res.Version != 5 {
		t.Fatalf("res=%+v err=%v", res, err)
	}
	if e.read(e.ap.CfgPath) != "global\n    daemon\n" || e.read(e.ap.MapPath) != "de.example be_de\n" {
		t.Fatal("файлы не заменены")
	}
	if res.Sha256 == nil || len(*res.Sha256) != 64 {
		t.Fatalf("sha: %v", res.Sha256)
	}
	// порядок: проверка → is-active → reload
	var seq []string
	for _, c := range e.fr.calls {
		seq = append(seq, c.name+" "+strings.Fields(c.args + " ")[0])
	}
	if strings.Join(seq, ",") != "haproxy -c,systemctl is-active,systemctl reload" {
		t.Fatalf("порядок вызовов: %v", seq)
	}
	if _, err := os.Stat(e.ap.CfgPath + ".popug-new"); err == nil {
		t.Fatal("временный файл остался")
	}
	ents, _ := os.ReadDir(e.ap.BackupDir)
	if len(ents) != 1 || e.read(filepath.Join(e.ap.BackupDir, ents[0].Name(), "haproxy.cfg")) != "OLD CFG\n" {
		t.Fatalf("бэкап: %v", ents)
	}
}

func TestValidationFailureTouchesNothing(t *testing.T) {
	e := newEnv(t, "OLD CFG\n", "old.example be_old\n")
	e.fr.haproxyFail = func(cfg string) bool { return strings.Contains(cfg, "foo") }
	res, err := e.ap.Apply(context.Background(), proto.ApplyArgs{Version: 6, Cfg: "global\n    foo bar\n", SniMap: "new.example be_new\n"})
	if err == nil || res.Applied || res.RolledBack {
		t.Fatalf("res=%+v err=%v", res, err)
	}
	if !strings.Contains(res.Output, "unknown keyword 'foo'") {
		t.Fatalf("вывод HAProxy потерян: %q", res.Output)
	}
	if e.read(e.ap.CfgPath) != "OLD CFG\n" || e.read(e.ap.MapPath) != "old.example be_old\n" {
		t.Fatal("конфиг или карта изменились после отказа проверки")
	}
	for _, c := range e.fr.calls {
		if c.name == "systemctl" {
			t.Fatalf("reload не должен вызываться: %v", e.fr.calls)
		}
	}
}

func TestFirstApplyWithoutMapRemovesItOnFailure(t *testing.T) {
	e := newEnv(t, "OLD\n", "")
	e.fr.haproxyFail = func(string) bool { return true }
	e.ap.Apply(context.Background(), proto.ApplyArgs{Version: 1, Cfg: "x\n", SniMap: "a b\n"})
	if _, err := os.Stat(e.ap.MapPath); err == nil {
		t.Fatal("карта, которой раньше не было, должна удаляться при отказе")
	}
}

func TestReloadFailureRollsBack(t *testing.T) {
	e := newEnv(t, "OLD CFG\n", "old.example be_old\n")
	e.fr.reloadFail = func(cfg string) bool { return strings.Contains(cfg, "BROKEN") }
	res, err := e.ap.Apply(context.Background(), proto.ApplyArgs{Version: 9, Cfg: "BROKEN\n", SniMap: "n.example be_n\n"})
	if err == nil || res.Applied || !res.RolledBack || res.RollbackFailed {
		t.Fatalf("res=%+v err=%v", res, err)
	}
	if e.read(e.ap.CfgPath) != "OLD CFG\n" || e.read(e.ap.MapPath) != "old.example be_old\n" {
		t.Fatal("после отката должны вернуться прежние файлы")
	}
	if !strings.Contains(res.Output, "Job for haproxy.service failed") {
		t.Fatalf("вывод systemctl потерян: %q", res.Output)
	}
	reloads := 0
	for _, c := range e.fr.calls {
		if c.name == "systemctl" && c.args == "reload haproxy" {
			reloads++
		}
	}
	if reloads != 2 {
		t.Fatalf("ожидалось 2 reload (применение и откат), было %d", reloads)
	}
	if res.Sha256 == nil || *res.Sha256 != sum([]byte("OLD CFG\n")) {
		t.Fatal("sha после отката должен быть прежним")
	}
}

func TestHealthTimeoutRollsBack(t *testing.T) {
	e := newEnv(t, "OLD CFG\n", "")
	e.health = func(cfg string) error {
		if strings.Contains(cfg, "NEW") {
			return errors.New("uptime не сбросился: старый процесс")
		}
		return nil
	}
	res, err := e.ap.Apply(context.Background(), proto.ApplyArgs{Version: 2, Cfg: "NEW CFG\n", SniMap: ""})
	if err == nil || res.Applied || !res.RolledBack {
		t.Fatalf("res=%+v err=%v", res, err)
	}
	if e.read(e.ap.CfgPath) != "OLD CFG\n" {
		t.Fatal("прежний конфиг не возвращён")
	}
	if e.clock.Sub(time.Unix(1_700_000_000, 0)) < e.ap.HealthTimeout {
		t.Fatalf("ждали меньше таймаута: %v", e.clock)
	}
}

func TestRollbackFailureIsReported(t *testing.T) {
	e := newEnv(t, "OLD CFG\n", "")
	e.health = func(string) error { return errors.New("не поднялся") } // и на новом, и на старом
	res, err := e.ap.Apply(context.Background(), proto.ApplyArgs{Version: 3, Cfg: "NEW\n"})
	if err == nil || res.Applied || res.RolledBack || !res.RollbackFailed {
		t.Fatalf("res=%+v err=%v", res, err)
	}
}

func TestInactiveHAProxyIsStartedNotReloaded(t *testing.T) {
	e := newEnv(t, "OLD\n", "")
	e.fr.inactive = true
	res, err := e.ap.Apply(context.Background(), proto.ApplyArgs{Version: 1, Cfg: "x\n"})
	if err != nil || !res.Applied {
		t.Fatalf("%+v %v", res, err)
	}
	last := e.fr.calls[len(e.fr.calls)-1]
	if last.args != "restart haproxy" {
		t.Fatalf("ожидался restart, последний вызов: %+v", last)
	}
}

func TestValidateOnly(t *testing.T) {
	e := newEnv(t, "OLD\n", "old a\n")
	res, err := e.ap.Apply(context.Background(), proto.ApplyArgs{Version: 1, Cfg: "x\n", SniMap: "new b\n", ValidateOnly: true})
	if err != nil || res.Applied {
		t.Fatalf("%+v %v", res, err)
	}
	if e.read(e.ap.CfgPath) != "OLD\n" || e.read(e.ap.MapPath) != "old a\n" {
		t.Fatal("validateOnly ничего не меняет")
	}
	if _, err := os.Stat(e.ap.BackupDir); err == nil {
		t.Fatal("validateOnly не делает бэкапов")
	}
}

func TestForbiddenDirectives(t *testing.T) {
	bad := []string{
		"program shell\n    command /bin/sh\n",
		"global\n    lua-load /tmp/x.lua\n",
		"backend b\n    option external-check\n    external-check command /bin/sh\n",
		"global\n\tSSL-ENGINE foo\n",
		"global\n   setenv FOO bar\n",
		"global\n  daemon\x00\n",
	}
	for _, c := range bad {
		if len(Forbidden(c)) == 0 {
			t.Errorf("должно быть запрещено: %q", c)
		}
	}
	ok := []string{
		"# program shell — просто комментарий\nglobal\n    daemon\n",
		"frontend fe\n    bind :443\n    default_backend be\nbackend be\n    server s 1.2.3.4:443 check\n",
		"backend program_exit\n    server s 1.2.3.4:443\n", // «program» внутри имени — не директива
	}
	for _, c := range ok {
		if bad := Forbidden(c); len(bad) != 0 {
			t.Errorf("ложное срабатывание на %q: %v", c, bad)
		}
	}
}

func TestForbiddenIsCheckedBeforeAnyWrite(t *testing.T) {
	e := newEnv(t, "OLD\n", "old a\n")
	res, err := e.ap.Apply(context.Background(), proto.ApplyArgs{Version: 1, Cfg: "program x\n    command id\n", SniMap: "n b\n"})
	if err == nil || len(e.fr.calls) != 0 {
		t.Fatalf("%+v %v calls=%v", res, err, e.fr.calls)
	}
	if e.read(e.ap.CfgPath) != "OLD\n" || e.read(e.ap.MapPath) != "old a\n" {
		t.Fatal("файлы изменены")
	}
}

func TestBackupsArePruned(t *testing.T) {
	e := newEnv(t, "OLD\n", "")
	e.ap.KeepBackups = 3
	for i := 1; i <= 6; i++ {
		e.clock = e.clock.Add(time.Minute)
		if _, err := e.ap.Apply(context.Background(), proto.ApplyArgs{Version: int64(i), Cfg: "cfg " + string(rune('a'+i)) + "\n"}); err != nil {
			t.Fatal(err)
		}
	}
	ents, _ := os.ReadDir(e.ap.BackupDir)
	if len(ents) != 3 {
		t.Fatalf("бэкапов %d, ожидалось 3", len(ents))
	}
}

// Общая политика с панелью: те же примеры лежат в protocol/fixtures/config_policy.json.
func TestSharedPolicyFixture(t *testing.T) {
	b, err := os.ReadFile(filepath.Join("..", "..", "..", "protocol", "fixtures", "config_policy.json"))
	if err != nil {
		t.Fatal(err)
	}
	var pol struct {
		Bad []string `json:"bad"`
		Ok  []string `json:"ok"`
	}
	if err := json.Unmarshal(b, &pol); err != nil {
		t.Fatal(err)
	}
	for _, c := range pol.Bad {
		if len(Forbidden(c)) == 0 {
			t.Errorf("агент пропустил то, что панель считает запрещённым: %q", c)
		}
	}
	for _, c := range pol.Ok {
		if bad := Forbidden(c); len(bad) != 0 {
			t.Errorf("агент запретил то, что панель считает допустимым: %q → %v", c, bad)
		}
	}
}

func TestReplaceFallsBackToInPlaceWriteWhenRenameFails(t *testing.T) {
	e := newEnv(t, "OLD CFG\n", "old a\n")
	// как с файлом, смонтированным в контейнер: rename → EBUSY
	e.ap.Rename = func(string, string) error { return errors.New("device or resource busy") }
	res, err := e.ap.Apply(context.Background(), proto.ApplyArgs{Version: 4, Cfg: "global\n    daemon\n", SniMap: "n b\n"})
	if err != nil || !res.Applied {
		t.Fatalf("res=%+v err=%v", res, err)
	}
	if e.read(e.ap.CfgPath) != "global\n    daemon\n" || e.read(e.ap.MapPath) != "n b\n" {
		t.Fatal("файлы не заменены запасным путём")
	}
	for _, p := range []string{e.ap.CfgPath + ".popug-new", e.ap.MapPath + ".popug-tmp"} {
		if _, err := os.Stat(p); err == nil {
			t.Fatalf("остался временный файл %s", p)
		}
	}
}
