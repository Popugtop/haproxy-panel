// Package apply — применение конфига HAProxy: проверка, атомарная замена, reload и откат.
//
// Безопасность: пути файлов и имена команд зашиты здесь и в локальном конфиге агента; из команды панели
// приходит только ТЕКСТ конфига и карты. Перед записью текст проходит denylist директив, которые
// заставляют HAProxy выполнять программы или грузить код (иначе взлом панели давал бы shell на мосту).
package apply

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"

	"popug-bridges/agent/internal/proto"
)

// Runner запускает фиксированные внешние команды (haproxy, systemctl); в тестах подменяется.
type Runner interface {
	Run(ctx context.Context, name string, args ...string) ([]byte, error)
}

type Applier struct {
	CfgPath   string // /etc/haproxy/haproxy.cfg
	MapPath   string // /etc/haproxy/maps/sni.map
	BackupDir string // /var/lib/popug-agent/backups
	Haproxy   string // бинарник haproxy (для -c)
	Run       Runner
	// Healthy возвращает nil, когда HAProxy ответил и работает уже на НОВОМ процессе (since — время с момента reload).
	Healthy       func(ctx context.Context, since time.Duration) error
	HealthTimeout time.Duration
	Now           func() time.Time
	Sleep         func(time.Duration)
	KeepBackups   int
	// Rename подменяется в тестах. По умолчанию os.Rename.
	Rename func(oldpath, newpath string) error
}

func New(cfgPath, mapPath, backupDir string, run Runner, healthy func(context.Context, time.Duration) error) *Applier {
	return &Applier{
		CfgPath: cfgPath, MapPath: mapPath, BackupDir: backupDir, Haproxy: "haproxy", Run: run, Healthy: healthy,
		HealthTimeout: 12 * time.Second, Now: time.Now, Sleep: time.Sleep, KeepBackups: 10, Rename: os.Rename,
	}
}

// forbidden — директивы HAProxy, дающие выполнение чужого кода. Сравнение по первому слову строки.
var forbidden = map[string]string{
	"program":             "секция program запускает внешние процессы",
	"external-check":      "external-check запускает внешние программы",
	"lua-load":            "lua-load загружает произвольный код",
	"lua-load-per-thread": "lua-load-per-thread загружает произвольный код",
	"lua-prepend-path":    "lua-prepend-path меняет пути загрузки кода",
	"ssl-engine":          "ssl-engine загружает внешние модули",
	"setenv":              "setenv меняет окружение процесса",
	"presetenv":           "presetenv меняет окружение процесса",
	"resetenv":            "resetenv меняет окружение процесса",
}

var wordRe = regexp.MustCompile(`^\s*([A-Za-z0-9_.-]+)`)

// Forbidden возвращает список найденных запрещённых директив (пустой — конфиг допустим).
func Forbidden(cfg string) []string {
	var out []string
	for i, line := range strings.Split(cfg, "\n") {
		if strings.ContainsRune(line, 0) {
			out = append(out, fmt.Sprintf("строка %d: нулевой байт", i+1))
			continue
		}
		m := wordRe.FindStringSubmatch(line)
		if m == nil || strings.HasPrefix(strings.TrimSpace(line), "#") {
			continue
		}
		if why, bad := forbidden[strings.ToLower(m[1])]; bad && why != "" {
			out = append(out, fmt.Sprintf("строка %d: %s", i+1, why))
		}
	}
	return out
}

func sum(b []byte) string {
	h := sha256.Sum256(b)
	return hex.EncodeToString(h[:])
}

func trunc(b []byte, n int) string {
	s := strings.TrimSpace(string(b))
	if len(s) > n {
		s = s[:n] + "…"
	}
	return s
}

// Apply выполняет операцию целиком. Результат всегда заполнен; ошибка — человекочитаемая причина отказа.
func (a *Applier) Apply(ctx context.Context, args proto.ApplyArgs) (proto.ApplyResult, error) {
	start := a.Now()
	res := proto.ApplyResult{Version: args.Version}
	done := func(err error) (proto.ApplyResult, error) {
		res.DurationMs = float64(a.Now().Sub(start).Microseconds()) / 1000
		return res, err
	}

	if strings.TrimSpace(args.Cfg) == "" {
		return done(errors.New("пустой конфиг"))
	}
	if bad := Forbidden(args.Cfg); len(bad) > 0 {
		res.Output = "запрещённые директивы:\n" + strings.Join(bad, "\n")
		return done(errors.New("конфиг содержит запрещённые директивы"))
	}

	// 1. Бэкап текущего состояния.
	oldCfg, cfgErr := os.ReadFile(a.CfgPath)
	oldMap, mapErr := os.ReadFile(a.MapPath)
	hadCfg, hadMap := cfgErr == nil, mapErr == nil
	if hadCfg {
		cur := sum(oldCfg)
		res.Sha256 = &cur
	}
	if !args.ValidateOnly {
		if err := a.backup(args.Version, oldCfg, hadCfg, oldMap, hadMap); err != nil {
			return done(fmt.Errorf("не удалось сделать бэкап: %w", err))
		}
	}

	// 2. Карта SNI кладётся на место ДО проверки: конфиг ссылается на неё по абсолютному пути.
	restoreMap := func() {
		if hadMap {
			_ = a.writeAtomic(a.MapPath, oldMap, 0o644)
		} else {
			_ = os.Remove(a.MapPath)
		}
	}
	if err := a.writeAtomic(a.MapPath, []byte(args.SniMap), 0o644); err != nil {
		return done(fmt.Errorf("не удалось записать карту SNI: %w", err))
	}

	tmp := a.CfgPath + ".popug-new"
	if err := writeAtomicName(tmp, []byte(args.Cfg), 0o644); err != nil {
		restoreMap()
		return done(fmt.Errorf("не удалось записать конфиг: %w", err))
	}
	defer os.Remove(tmp)

	// 3. haproxy -c на кандидате.
	out, err := a.Run.Run(ctx, a.Haproxy, "-c", "-f", tmp)
	res.Output = trunc(out, 6000)
	if err != nil {
		restoreMap()
		return done(errors.New("HAProxy отклонил конфиг (haproxy -c), на ноде ничего не изменилось"))
	}
	if args.ValidateOnly {
		restoreMap()
		return done(nil)
	}

	// 4. Атомарная замена и reload.
	if err := a.replace(tmp, a.CfgPath); err != nil {
		restoreMap()
		return done(fmt.Errorf("не удалось заменить конфиг: %w", err))
	}
	newSum := sum([]byte(args.Cfg))
	res.Sha256 = &newSum

	if rerr := a.reloadAndWait(ctx); rerr != nil {
		res.Output = trunc([]byte(res.Output+"\n"+rerr.Error()), 6000)
		// 5. Откат.
		if hadCfg {
			if werr := a.writeAtomic(a.CfgPath, oldCfg, 0o644); werr != nil {
				res.RollbackFailed = true
				return done(fmt.Errorf("конфиг не применился (%v), откат тоже не удался: %v", rerr, werr))
			}
			restoreMap()
			if err := a.reloadAndWait(ctx); err != nil {
				res.RollbackFailed = true
				res.Output = trunc([]byte(res.Output+"\nоткат: "+err.Error()), 6000)
				return done(fmt.Errorf("конфиг не применился (%v), а после отката HAProxy не поднялся: %v", rerr, err))
			}
			old := sum(oldCfg)
			res.Sha256 = &old
			res.RolledBack = true
			return done(fmt.Errorf("конфиг не применился, возвращён прежний: %v", rerr))
		}
		restoreMap()
		res.RollbackFailed = true
		return done(fmt.Errorf("конфиг не применился (%v), прежнего конфига не было — откатывать некуда", rerr))
	}
	res.Applied = true
	a.prune()
	return done(nil)
}

// reloadAndWait: reload (или start, если HAProxy не запущен) и ожидание, пока поднимется новый процесс.
func (a *Applier) reloadAndWait(ctx context.Context) error {
	t0 := a.Now()
	verb := "reload"
	if _, err := a.Run.Run(ctx, "systemctl", "is-active", "--quiet", "haproxy"); err != nil {
		verb = "restart"
	}
	if out, err := a.Run.Run(ctx, "systemctl", verb, "haproxy"); err != nil {
		return fmt.Errorf("systemctl %s haproxy: %v: %s", verb, err, trunc(out, 1500))
	}
	deadline := t0.Add(a.HealthTimeout)
	var last error
	for {
		last = a.Healthy(ctx, a.Now().Sub(t0))
		if last == nil {
			return nil
		}
		if a.Now().After(deadline) {
			// Журнал HAProxy помогает понять причину: достаём хвост через фиксированную команду.
			j, _ := a.Run.Run(ctx, "journalctl", "-u", "haproxy", "-n", "12", "--no-pager", "-o", "cat")
			return fmt.Errorf("HAProxy не поднялся за %s (%v). Журнал:\n%s", a.HealthTimeout, last, trunc(j, 2000))
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		default:
		}
		a.Sleep(500 * time.Millisecond)
	}
}

func (a *Applier) backup(version int64, cfg []byte, hadCfg bool, m []byte, hadMap bool) error {
	dir := filepath.Join(a.BackupDir, fmt.Sprintf("%s-v%d", a.Now().UTC().Format("20060102T150405"), version))
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	if hadCfg {
		if err := os.WriteFile(filepath.Join(dir, "haproxy.cfg"), cfg, 0o600); err != nil {
			return err
		}
	}
	if hadMap {
		return os.WriteFile(filepath.Join(dir, "sni.map"), m, 0o600)
	}
	return nil
}

func (a *Applier) prune() {
	ents, err := os.ReadDir(a.BackupDir)
	if err != nil || len(ents) <= a.KeepBackups {
		return
	}
	names := make([]string, 0, len(ents))
	for _, e := range ents {
		names = append(names, e.Name())
	}
	sort.Strings(names)
	for _, n := range names[:len(names)-a.KeepBackups] {
		_ = os.RemoveAll(filepath.Join(a.BackupDir, n))
	}
}

func (a *Applier) writeAtomic(path string, data []byte, mode os.FileMode) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	tmp := path + ".popug-tmp"
	if err := writeAtomicName(tmp, data, mode); err != nil {
		return err
	}
	return a.replace(tmp, path)
}

// replace кладёт tmp на место final атомарным rename. Если rename невозможен (файл — точка монтирования,
// другая файловая система), перезаписывает final на месте: менее атомарно, но работает везде.
func (a *Applier) replace(tmp, final string) error {
	rename := a.Rename
	if rename == nil {
		rename = os.Rename
	}
	if err := rename(tmp, final); err == nil {
		return nil
	}
	data, err := os.ReadFile(tmp)
	if err != nil {
		return err
	}
	if err := os.WriteFile(final, data, 0o644); err != nil {
		return err
	}
	return os.Remove(tmp)
}

// writeAtomicName пишет данные во временный файл с fsync.
func writeAtomicName(tmp string, data []byte, mode os.FileMode) error {
	f, err := os.OpenFile(tmp, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, mode)
	if err != nil {
		return err
	}
	if _, err := f.Write(data); err != nil {
		f.Close()
		return err
	}
	if err := f.Sync(); err != nil {
		f.Close()
		return err
	}
	return f.Close()
}
