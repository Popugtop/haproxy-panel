package haproxy

import (
	"context"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"popug-bridges/agent/internal/proto"
)

// Client разговаривает со stats-сокетом HAProxy.
type Client struct {
	Socket string
	Table  string
}

func NewClient(socket, table string) *Client { return &Client{Socket: socket, Table: table} }

// Query отправляет одну команду и читает ответ до закрытия соединения.
func (c *Client) Query(ctx context.Context, cmd string) ([]byte, error) {
	d := net.Dialer{Timeout: 3 * time.Second}
	conn, err := d.DialContext(ctx, "unix", c.Socket)
	if err != nil {
		return nil, fmt.Errorf("stats-сокет %s недоступен: %w", c.Socket, err)
	}
	defer conn.Close()
	deadline := time.Now().Add(10 * time.Second)
	if dl, ok := ctx.Deadline(); ok && dl.Before(deadline) {
		deadline = dl
	}
	_ = conn.SetDeadline(deadline)
	if _, err := conn.Write([]byte(cmd + "\n")); err != nil {
		return nil, err
	}
	return io.ReadAll(io.LimitReader(conn, 64<<20))
}

// Snapshot — всё, что агент снимает с HAProxy за один проход.
type Snapshot struct {
	HAProxy      proto.HAProxyMetrics
	Clients      *proto.Clients
	ClientsError *string
}

func (c *Client) Snapshot(ctx context.Context, topN int) Snapshot {
	snap := Snapshot{HAProxy: proto.HAProxyMetrics{Backends: []proto.BackendStat{}, Frontends: []proto.FrontendStat{}}}
	fail := func(err error) Snapshot {
		snap.HAProxy.OK = false
		snap.HAProxy.Error = proto.Str(err.Error())
		return snap
	}

	b, err := c.Query(ctx, "show info")
	if err != nil {
		return fail(err)
	}
	info, err := ParseInfo(strings.NewReader(string(b)))
	if err != nil {
		return fail(err)
	}
	snap.HAProxy.Version = &info.Version
	snap.HAProxy.UptimeSec = &info.UptimeSec

	if b, err = c.Query(ctx, "show stat"); err != nil {
		return fail(err)
	}
	be, fe, err := ParseStat(strings.NewReader(string(b)))
	if err != nil {
		return fail(err)
	}
	snap.HAProxy.Backends, snap.HAProxy.Frontends, snap.HAProxy.OK = be, fe, true

	if c.Table != "" {
		tb, err := c.Query(ctx, "show table "+c.Table)
		var rows []proto.ClientRow
		var used int64
		if err == nil {
			rows, used, err = ParseTable(strings.NewReader(string(tb)))
		}
		if err != nil {
			snap.ClientsError = proto.Str(fmt.Sprintf("таблица %s: %v", c.Table, err))
		} else {
			s := Summarize(rows, used, topN)
			snap.Clients = &s
		}
	}
	return snap
}

var versionRe = regexp.MustCompile(`(?i)HA-?Proxy version ([0-9][^ ]*)`)

// Detect: установлен ли HAProxy, его версия и запущен ли сервис. Только фиксированные команды.
func Detect(ctx context.Context) proto.HAProxyInfo {
	info := proto.HAProxyInfo{}
	path, err := exec.LookPath("haproxy")
	if err != nil {
		return info
	}
	info.Installed = true
	cctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	if out, err := exec.CommandContext(cctx, path, "-v").Output(); err == nil {
		if m := versionRe.FindSubmatch(out); m != nil {
			v := string(m[1])
			info.Version = &v
		}
	}
	if err := exec.CommandContext(cctx, "systemctl", "is-active", "--quiet", "haproxy").Run(); err == nil {
		info.Running = true
	}
	return info
}

// ReadConfig читает haproxy.cfg для операции get_config.
func ReadConfig(path string) ([]byte, error) {
	st, err := os.Stat(path)
	if err != nil {
		return nil, err
	}
	if st.Size() > 2_000_000 {
		return nil, fmt.Errorf("конфиг больше 2 МБ")
	}
	return os.ReadFile(path)
}

// Healthy: HAProxy отвечает на stats-сокет и работает уже на новом процессе, то есть reload состоялся.
// since — время с момента reload; у свежего воркера Uptime_sec не больше since (с запасом 2 с).
func (c *Client) Healthy(ctx context.Context, since time.Duration) error {
	b, err := c.Query(ctx, "show info")
	if err != nil {
		return err
	}
	info, err := ParseInfo(strings.NewReader(string(b)))
	if err != nil {
		return err
	}
	if info.UptimeSec > int64(since.Seconds())+2 {
		return fmt.Errorf("HAProxy отвечает, но uptime %d с больше времени после reload (%.0f с): новый процесс не поднялся", info.UptimeSec, since.Seconds())
	}
	return nil
}

// Clients — живая таблица клиентов (операция get_clients): глубже, чем в метриках, и без ожидания следующего снимка.
func (c *Client) Clients(ctx context.Context, topN int) (proto.Clients, error) {
	if c.Table == "" {
		return proto.Clients{}, fmt.Errorf("таблица клиентов не настроена")
	}
	tb, err := c.Query(ctx, "show table "+c.Table)
	if err != nil {
		return proto.Clients{}, err
	}
	rows, used, err := ParseTable(strings.NewReader(string(tb)))
	if err != nil {
		return proto.Clients{}, fmt.Errorf("таблица %s: %v", c.Table, err)
	}
	return Summarize(rows, used, topN), nil
}

const (
	maxMapBytes = 1_000_000
	maxMapFiles = 8
)

// mapRefRe находит map(/путь/к/файлу[,значение_по_умолчанию]) и map_str/map_beg/… в тексте конфига.
var mapRefRe = regexp.MustCompile(`\bmap(?:_[a-z]+)?\(\s*([^),\s]+)`)

// ReadReferencedMaps читает карты, упомянутые в конфиге, для импорта SNI-маршрутов.
//
// Безопасность: путь берётся из текста конфига на самой ноде, но панель могла положить в конфиг что угодно,
// поэтому читается только обычный файл *.map, который после раскрытия символических ссылок остаётся внутри
// каталога конфига (обычно /etc/haproxy). Размер и число файлов ограничены. Остальное молча пропускается.
func ReadReferencedMaps(cfgPath, cfgText string) []proto.ConfigMap {
	base, err := filepath.EvalSymlinks(filepath.Dir(cfgPath))
	if err != nil {
		return nil
	}
	var out []proto.ConfigMap
	seen := map[string]bool{}
	for _, m := range mapRefRe.FindAllStringSubmatch(cfgText, -1) {
		raw := m[1]
		if seen[raw] || len(out) >= maxMapFiles || !filepath.IsAbs(raw) || !strings.HasSuffix(raw, ".map") {
			continue
		}
		seen[raw] = true
		real, err := filepath.EvalSymlinks(filepath.Clean(raw))
		if err != nil || !strings.HasPrefix(real, base+string(filepath.Separator)) {
			continue
		}
		st, err := os.Stat(real)
		if err != nil || !st.Mode().IsRegular() || st.Size() > maxMapBytes {
			continue
		}
		b, err := os.ReadFile(real)
		if err != nil {
			continue
		}
		out = append(out, proto.ConfigMap{Path: raw, Content: string(b)})
	}
	return out
}
