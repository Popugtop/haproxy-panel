package update

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"popug-bridges/agent/internal/proto"
)

type rec struct{ calls []string }

func (r *rec) Run(_ context.Context, name string, args ...string) ([]byte, error) {
	r.calls = append(r.calls, name+" "+strings.Join(args, " "))
	return nil, nil
}

type rig struct {
	dir    string
	srv    *httptest.Server
	u      *Updater
	run    *rec
	priv   ed25519.PrivateKey
	newBin []byte
	hits   *int32
}

func newRig(t *testing.T, current, version string, mutate func(r *rig)) *rig {
	t.Helper()
	pub, priv, _ := ed25519.GenerateKey(rand.Reader)
	r := &rig{dir: t.TempDir(), priv: priv, run: &rec{}, hits: new(int32), newBin: []byte("NEW-BINARY-" + version)}
	if mutate != nil {
		mutate(r)
	}
	sum := sha256.Sum256(r.newBin)
	sha := hex.EncodeToString(sum[:])
	sig := base64.StdEncoding.EncodeToString(ed25519.Sign(priv, SignedMessage(version, "amd64", sha)))
	r.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, q *http.Request) {
		atomic.AddInt32(r.hits, 1)
		switch q.URL.Path {
		case "/dl/popug-agent-linux-amd64":
			w.Write(r.newBin)
		case "/dl/popug-agent-linux-amd64.sig":
			w.Write([]byte(sig + "\n"))
		default:
			http.NotFound(w, q)
		}
	}))
	t.Cleanup(r.srv.Close)
	bin := filepath.Join(r.dir, "popug-agent")
	os.WriteFile(bin, []byte("OLD-BINARY"), 0o755)
	r.u = New(r.srv.URL, current, "amd64", bin, filepath.Join(r.dir, "state"), pub, r.run)
	r.u.Sleep = func(time.Duration) {}
	r.u.Probe = func(_ context.Context, path string) (string, error) { return version, nil }
	return r
}

func (r *rig) args(version string) proto.UpdateArgs {
	sum := sha256.Sum256(r.newBin)
	return proto.UpdateArgs{Version: version, Sha256: hex.EncodeToString(sum[:])}
}

func TestUpdateSuccess(t *testing.T) {
	r := newRig(t, "0.2.0", "0.3.0", nil)
	res, err := r.u.Update(context.Background(), r.args("0.3.0"))
	if err != nil || !res.Restarting || res.From != "0.2.0" || res.To != "0.3.0" {
		t.Fatalf("%+v %v", res, err)
	}
	if b, _ := os.ReadFile(r.u.BinPath); string(b) != "NEW-BINARY-0.3.0" {
		t.Fatal("бинарник не заменён")
	}
	if b, _ := os.ReadFile(r.u.BinPath + ".prev"); string(b) != "OLD-BINARY" {
		t.Fatal("прежняя версия не сохранена")
	}
	if _, err := os.Stat(r.u.markerPath()); err != nil {
		t.Fatal("нет маркера ожидания подтверждения")
	}
	time.Sleep(100 * time.Millisecond) // перезапуск идёт в горутине
	if len(r.run.calls) != 1 || r.run.calls[0] != "systemctl restart popug-agent" {
		t.Fatalf("перезапуск: %v", r.run.calls)
	}
}

func TestUpdateRefusals(t *testing.T) {
	ctx := context.Background()
	t.Run("без закреплённого ключа", func(t *testing.T) {
		r := newRig(t, "0.2.0", "0.3.0", nil)
		r.u.PubKey = nil
		if _, err := r.u.Update(ctx, r.args("0.3.0")); err == nil || !strings.Contains(err.Error(), "отключено") {
			t.Fatal(err)
		}
		if atomic.LoadInt32(r.hits) != 0 {
			t.Fatal("без ключа агент не должен даже скачивать")
		}
	})
	t.Run("понижение версии", func(t *testing.T) {
		r := newRig(t, "0.3.0", "0.2.0", nil)
		if _, err := r.u.Update(ctx, r.args("0.2.0")); err == nil || !strings.Contains(err.Error(), "понижать") {
			t.Fatal(err)
		}
		if _, err := r.u.Update(ctx, r.args("0.3.0")); err == nil { // та же версия
			t.Fatal("та же версия должна отклоняться")
		}
	})
	t.Run("подмена бинарника: хеш не совпал", func(t *testing.T) {
		r := newRig(t, "0.2.0", "0.3.0", nil)
		a := r.args("0.3.0")
		a.Sha256 = strings.Repeat("a", 64)
		if _, err := r.u.Update(ctx, a); err == nil || !strings.Contains(err.Error(), "SHA-256") {
			t.Fatal(err)
		}
		if b, _ := os.ReadFile(r.u.BinPath); string(b) != "OLD-BINARY" {
			t.Fatal("бинарник изменён")
		}
	})
	t.Run("подпись чужим ключом (взломанная панель)", func(t *testing.T) {
		r := newRig(t, "0.2.0", "0.3.0", nil)
		attacker, _, _ := ed25519.GenerateKey(rand.Reader)
		r.u.PubKey = attacker // агент закрепил ДРУГОЙ ключ, чем тот, которым подписано
		if _, err := r.u.Update(ctx, r.args("0.3.0")); err == nil || !strings.Contains(err.Error(), "подпись") {
			t.Fatal(err)
		}
		if b, _ := os.ReadFile(r.u.BinPath); string(b) != "OLD-BINARY" {
			t.Fatal("бинарник с неверной подписью был установлен")
		}
	})
	t.Run("подпись от другой версии (повтор старого релиза)", func(t *testing.T) {
		r := newRig(t, "0.2.0", "0.2.5", nil) // подпись выпущена на 0.2.5
		a := r.args("0.9.0")                  // а панель называет её 0.9.0
		if _, err := r.u.Update(ctx, a); err == nil || !strings.Contains(err.Error(), "подпись") {
			t.Fatal(err)
		}
	})
	t.Run("бинарник называет другую версию (не та архитектура)", func(t *testing.T) {
		r := newRig(t, "0.2.0", "0.3.0", nil)
		r.u.Probe = func(context.Context, string) (string, error) { return "0.2.0", nil }
		if _, err := r.u.Update(ctx, r.args("0.3.0")); err == nil || !strings.Contains(err.Error(), "называет себя") {
			t.Fatal(err)
		}
		if b, _ := os.ReadFile(r.u.BinPath); string(b) != "OLD-BINARY" {
			t.Fatal("бинарник изменён")
		}
	})
	t.Run("мусор в версии", func(t *testing.T) {
		r := newRig(t, "0.2.0", "0.3.0", nil)
		a := r.args("0.3.0")
		a.Version = "../../etc/passwd"
		if _, err := r.u.Update(ctx, a); err == nil {
			t.Fatal("версия-путь должна отклоняться")
		}
	})
}

func TestNewer(t *testing.T) {
	cases := []struct {
		a, b string
		want bool
	}{{"0.3.0", "0.2.9", true}, {"0.10.0", "0.9.0", true}, {"1.0.0", "0.99.99", true}, {"0.2.0", "0.2.0", false}, {"0.2.0", "0.3.0", false}, {"v0.3.1-rc1", "0.3.0", true}, {"0.3", "0.3.0", false}}
	for _, c := range cases {
		if Newer(c.a, c.b) != c.want {
			t.Errorf("Newer(%s,%s) != %v", c.a, c.b, c.want)
		}
	}
}

func TestWatchdogRestoresPreviousBinaryWhenNewOneNeverConnects(t *testing.T) {
	r := newRig(t, "0.2.0", "0.3.0", nil)
	if _, err := r.u.Update(context.Background(), r.args("0.3.0")); err != nil {
		t.Fatal(err)
	}
	time.Sleep(50 * time.Millisecond)
	r.run.calls = nil
	// «Новый процесс»: тот же каталог состояния, welcome так и не пришёл.
	u2 := New(r.srv.URL, "0.3.0", "amd64", r.u.BinPath, r.u.StateDir, r.u.PubKey, r.run)
	u2.WatchdogTimeout = 100 * time.Millisecond
	u2.StartWatchdog(context.Background())
	time.Sleep(400 * time.Millisecond)
	if b, _ := os.ReadFile(r.u.BinPath); string(b) != "OLD-BINARY" {
		t.Fatalf("прежний бинарник не восстановлен: %q", b)
	}
	if len(r.run.calls) != 1 || !strings.Contains(r.run.calls[0], "restart popug-agent") {
		t.Fatalf("нет перезапуска после отката: %v", r.run.calls)
	}
}

func TestWatchdogStandsDownAfterWelcome(t *testing.T) {
	r := newRig(t, "0.2.0", "0.3.0", nil)
	r.u.Update(context.Background(), r.args("0.3.0"))
	time.Sleep(50 * time.Millisecond)
	r.run.calls = nil
	u2 := New(r.srv.URL, "0.3.0", "amd64", r.u.BinPath, r.u.StateDir, r.u.PubKey, r.run)
	u2.WatchdogTimeout = 150 * time.Millisecond
	u2.StartWatchdog(context.Background())
	u2.MarkHealthy() // welcome пришёл
	time.Sleep(400 * time.Millisecond)
	if b, _ := os.ReadFile(r.u.BinPath); string(b) != "NEW-BINARY-0.3.0" {
		t.Fatal("после успешного подключения новая версия должна остаться")
	}
	if len(r.run.calls) != 0 {
		t.Fatalf("лишний перезапуск: %v", r.run.calls)
	}
	if _, err := os.Stat(u2.markerPath()); err == nil {
		t.Fatal("маркер не удалён")
	}
}

func TestExecRunnerOnlyAllowsOneCommand(t *testing.T) {
	for _, args := range [][]string{{"stop", "popug-agent"}, {"restart", "sshd"}, {"restart", "popug-agent", "--now"}, {}} {
		if _, err := (ExecRunner{}).Run(context.Background(), "systemctl", args...); err == nil {
			t.Errorf("%v не должно запускаться", args)
		}
	}
	if _, err := (ExecRunner{}).Run(context.Background(), "sh", "-c", "id"); err == nil {
		t.Error("sh не должен запускаться")
	}
}

func TestFailedReplaceLeavesNoTraces(t *testing.T) {
	r := newRig(t, "0.2.0", "0.3.0", nil)
	// каталог с бинарником только для чтения: rename нового файла невозможен
	if err := os.Chmod(filepath.Dir(r.u.BinPath), 0o500); err != nil {
		t.Skip("не удалось ограничить каталог")
	}
	defer os.Chmod(filepath.Dir(r.u.BinPath), 0o700)
	if os.Geteuid() == 0 {
		t.Skip("root обходит права каталога")
	}
	if _, err := r.u.Update(context.Background(), r.args("0.3.0")); err == nil {
		t.Fatal("ожидалась ошибка")
	}
	os.Chmod(filepath.Dir(r.u.BinPath), 0o700)
	if _, err := os.Stat(r.u.BinPath + ".prev"); err == nil {
		t.Fatal("остался .prev")
	}
	if b, _ := os.ReadFile(r.u.BinPath); string(b) != "OLD-BINARY" {
		t.Fatal("бинарник изменён")
	}
}
