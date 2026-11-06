// Package update — самообновление агента по команде панели.
//
// Модель доверия: панель только ПРОСИТ обновиться. Бинарник агент скачивает сам с адреса панели из своего
// локального конфига, а ставит его, только если подпись ed25519 сходится с ключом, закреплённым при установке
// (/etc/popug-agent/update.pub). Приватный ключ релизов у владельца, не у панели, поэтому взлом панели не даёт
// возможности подсунуть бинарник. Подпись привязана к версии, архитектуре и хешу: откат на старую версию не пройдёт.
package update

import (
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	"popug-bridges/agent/internal/proto"
)

const maxBinary = 64 << 20

var versionRe = regexp.MustCompile(`^[0-9A-Za-z][0-9A-Za-z._+-]{0,39}$`)

type Runner interface {
	Run(ctx context.Context, name string, args ...string) ([]byte, error)
}

type Updater struct {
	PanelURL string
	Arch     string // amd64 | arm64
	Current  string
	PubKey   ed25519.PublicKey // nil — обновление отключено
	BinPath  string
	StateDir string
	HTTP     *http.Client
	Run      Runner
	// Probe запускает проверенный бинарник с `version` и возвращает его вывод.
	Probe func(ctx context.Context, path string) (string, error)
	Now   func() time.Time
	Sleep func(time.Duration)
	// WatchdogTimeout — сколько ждать первого welcome от панели после обновления.
	WatchdogTimeout time.Duration
	healthy         chan struct{}
}

func New(panelURL, current, arch, binPath, stateDir string, pub ed25519.PublicKey, run Runner) *Updater {
	return &Updater{
		PanelURL: strings.TrimRight(panelURL, "/"), Arch: arch, Current: current, PubKey: pub, BinPath: binPath, StateDir: stateDir,
		HTTP: &http.Client{Timeout: 3 * time.Minute, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }},
		Run:  run, Probe: probeBinary, Now: time.Now, Sleep: time.Sleep, WatchdogTimeout: 90 * time.Second, healthy: make(chan struct{}),
	}
}

// LoadPubKey читает ключ (base64, 32 байта). Нет файла — nil: обновление по кнопке выключено.
func LoadPubKey(path string) ed25519.PublicKey {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	raw, err := base64.StdEncoding.DecodeString(strings.TrimSpace(string(b)))
	if err != nil || len(raw) != ed25519.PublicKeySize {
		return nil
	}
	return ed25519.PublicKey(raw)
}

// SignedMessage — то, что подписывается при выпуске: версия, архитектура и хеш бинарника.
func SignedMessage(version, arch, sha string) []byte {
	return []byte("popug-agent\n" + version + "\n" + arch + "\n" + sha + "\n")
}

// Newer: a строго новее b (числовые компоненты через точку; суффиксы вроде -rc игнорируются).
func Newer(a, b string) bool {
	pa, pb := parts(a), parts(b)
	for i := 0; i < len(pa) || i < len(pb); i++ {
		var x, y int
		if i < len(pa) {
			x = pa[i]
		}
		if i < len(pb) {
			y = pb[i]
		}
		if x != y {
			return x > y
		}
	}
	return false
}

func parts(v string) []int {
	v = strings.TrimPrefix(v, "v")
	if i := strings.IndexAny(v, "-+"); i >= 0 {
		v = v[:i]
	}
	var out []int
	for _, s := range strings.Split(v, ".") {
		n, err := strconv.Atoi(s)
		if err != nil {
			n = 0
		}
		out = append(out, n)
	}
	return out
}

func (u *Updater) fetch(ctx context.Context, path string, limit int64) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.PanelURL+path, nil)
	if err != nil {
		return nil, err
	}
	resp, err := u.HTTP.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("панель отдала HTTP %d на %s", resp.StatusCode, path)
	}
	b, err := io.ReadAll(io.LimitReader(resp.Body, limit+1))
	if err != nil {
		return nil, err
	}
	if int64(len(b)) > limit {
		return nil, fmt.Errorf("%s больше %d МБ", path, limit>>20)
	}
	return b, nil
}

type pending struct {
	From string `json:"from"`
	To   string `json:"to"`
	At   int64  `json:"at"`
	Prev string `json:"prev"`
}

func (u *Updater) markerPath() string { return filepath.Join(u.StateDir, "update-pending.json") }

// Update выполняет операцию update_agent. После успеха процесс сам перезапустится через systemd.
func (u *Updater) Update(ctx context.Context, a proto.UpdateArgs) (proto.UpdateResult, error) {
	res := proto.UpdateResult{From: u.Current, To: a.Version}
	if u.PubKey == nil {
		return res, errors.New("обновление по кнопке отключено: на ноде нет закреплённого ключа подписи (/etc/popug-agent/update.pub). Обновите агент командой установки")
	}
	if !versionRe.MatchString(a.Version) {
		return res, errors.New("некорректная версия")
	}
	if !Newer(a.Version, u.Current) {
		return res, fmt.Errorf("версия %s не новее текущей %s: понижать агент нельзя", a.Version, u.Current)
	}
	if u.Arch != "amd64" && u.Arch != "arm64" {
		return res, fmt.Errorf("архитектура %s не поддерживается", u.Arch)
	}

	bin, err := u.fetch(ctx, "/dl/popug-agent-linux-"+u.Arch, maxBinary)
	if err != nil {
		return res, fmt.Errorf("не удалось скачать бинарник: %w", err)
	}
	sum := sha256.Sum256(bin)
	got := hex.EncodeToString(sum[:])
	if !strings.EqualFold(got, a.Sha256) {
		return res, fmt.Errorf("SHA-256 бинарника (%s…) не совпал с ожидаемым (%s…)", got[:12], a.Sha256[:12])
	}
	sigB64, err := u.fetch(ctx, "/dl/popug-agent-linux-"+u.Arch+".sig", 4096)
	if err != nil {
		return res, fmt.Errorf("не удалось скачать подпись: %w", err)
	}
	sig, err := base64.StdEncoding.DecodeString(strings.TrimSpace(string(sigB64)))
	if err != nil || len(sig) != ed25519.SignatureSize {
		return res, errors.New("подпись повреждена")
	}
	if !ed25519.Verify(u.PubKey, SignedMessage(a.Version, u.Arch, got), sig) {
		return res, errors.New("подпись бинарника не сходится с закреплённым ключом: обновление отклонено")
	}

	if err := os.MkdirAll(u.StateDir, 0o700); err != nil {
		return res, err
	}
	newPath := u.BinPath + ".new"
	if err := os.WriteFile(newPath, bin, 0o755); err != nil {
		return res, fmt.Errorf("не удалось записать новый бинарник: %w", err)
	}
	defer os.Remove(newPath)
	// Проверенный подписью бинарник должен ещё и запускаться и называть ту самую версию (ловит неверную архитектуру).
	out, err := u.Probe(ctx, newPath)
	if err != nil {
		return res, fmt.Errorf("новый бинарник не запускается: %w", err)
	}
	if strings.TrimSpace(out) != a.Version {
		return res, fmt.Errorf("новый бинарник называет себя версией %q, ожидалась %q", strings.TrimSpace(out), a.Version)
	}

	prev := u.BinPath + ".prev"
	_ = os.Remove(prev)
	if err := os.Link(u.BinPath, prev); err != nil { // жёсткая ссылка не стирает работающий бинарник
		if cerr := copyFile(u.BinPath, prev); cerr != nil {
			return res, fmt.Errorf("не удалось сохранить прежнюю версию: %w", cerr)
		}
	}
	if err := os.Rename(newPath, u.BinPath); err != nil {
		_ = os.Remove(prev) // откатываем собственные следы: прежний бинарник остаётся единственным
		return res, fmt.Errorf("не удалось заменить бинарник: %w", err)
	}
	m, _ := json.Marshal(pending{From: u.Current, To: a.Version, At: u.Now().Unix(), Prev: prev})
	if err := os.WriteFile(u.markerPath(), m, 0o600); err != nil {
		return res, err
	}

	res.Restarting = true
	// Перезапуск чуть позже: ответ панели должен успеть уйти. Новый процесс подтвердит себя первым welcome.
	go func() {
		u.Sleep(2 * time.Second)
		_, _ = u.Run.Run(context.Background(), "systemctl", "restart", "popug-agent")
	}()
	return res, nil
}

func copyFile(src, dst string) error {
	b, err := os.ReadFile(src)
	if err != nil {
		return err
	}
	return os.WriteFile(dst, b, 0o755)
}

func probeBinary(ctx context.Context, path string) (string, error) {
	return execOutput(ctx, path, "version")
}

// MarkHealthy вызывается после первого welcome: новая версия подключилась, прежнюю копию можно не восстанавливать.
func (u *Updater) MarkHealthy() {
	select {
	case <-u.healthy:
	default:
		close(u.healthy)
	}
	_ = os.Remove(u.markerPath())
}

// StartWatchdog после обновления ждёт welcome; не дождался — возвращает прежний бинарник и перезапускает агент.
func (u *Updater) StartWatchdog(ctx context.Context) {
	b, err := os.ReadFile(u.markerPath())
	if err != nil {
		return
	}
	var p pending
	if json.Unmarshal(b, &p) != nil || u.Now().Unix()-p.At > int64(10*time.Minute/time.Second) {
		_ = os.Remove(u.markerPath())
		return
	}
	go func() {
		select {
		case <-u.healthy:
		case <-ctx.Done():
		case <-time.After(u.WatchdogTimeout):
			if _, err := os.Stat(p.Prev); err == nil {
				if err := os.Rename(p.Prev, u.BinPath); err == nil {
					_ = os.Remove(u.markerPath())
					_, _ = u.Run.Run(context.Background(), "systemctl", "restart", "popug-agent")
				}
			}
		}
	}()
}
