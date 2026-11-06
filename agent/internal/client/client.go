// Package client — исходящее WebSocket-соединение агента с панелью.
package client

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"math/rand"
	"net"
	"net/http"
	"net/netip"
	"os"
	"runtime"
	"strings"
	"time"

	"github.com/coder/websocket"

	"popug-bridges/agent/internal/apply"
	"popug-bridges/agent/internal/bans"
	"popug-bridges/agent/internal/checks"
	"popug-bridges/agent/internal/config"
	"popug-bridges/agent/internal/haproxy"
	"popug-bridges/agent/internal/ops"
	"popug-bridges/agent/internal/proto"
	"popug-bridges/agent/internal/sysinfo"
	"popug-bridges/agent/internal/update"
)

const (
	minBackoff   = time.Second
	maxBackoff   = 60 * time.Second
	fatalBackoff = 5 * time.Minute // ключ отозван / версия несовместима: бесполезно долбить панель
	readLimit    = 4 << 20
)

type Client struct {
	Cfg     config.Config
	Key     string
	Version string
	Log     *slog.Logger

	hap    *haproxy.Client
	sys    *sysinfo.Collector
	ops    *ops.Dispatcher
	checks *checks.Runner
	upd    *update.Updater
	seq    int64
}

func New(cfg config.Config, key, version string, log *slog.Logger) *Client {
	hap := haproxy.NewClient(cfg.HAProxySocket, cfg.StatsTable)
	d := ops.New(cfg.HAProxyConfig)
	d.Checks = checks.NewRunner()
	d.Applier = apply.New(cfg.HAProxyConfig, cfg.HAProxyMap, cfg.BackupDir, apply.ExecRunner{}, hap.Healthy)
	d.Bans = bans.New(bans.ExecRunner{})
	d.Clients = func(ctx context.Context) (any, error) { return hap.Clients(ctx, 200) }
	exe, _ := os.Executable()
	upd := update.New(cfg.PanelURL, version, runtime.GOARCH, exe, cfg.StateDir, update.LoadPubKey(cfg.UpdateKeyFile), update.ExecRunner{})
	d.Updater = upd
	return &Client{Cfg: cfg, Key: key, Version: version, Log: log, hap: hap, sys: sysinfo.NewCollector(), ops: d, checks: d.Checks, upd: upd}
}

// Run блокируется до отмены ctx; обрывы связи переживает с экспоненциальным backoff.
func (c *Client) Run(ctx context.Context) {
	c.upd.StartWatchdog(ctx) // после обновления: не подключились за 90 с — вернуть прежний бинарник
	wait := minBackoff
	for ctx.Err() == nil {
		started := time.Now()
		err := c.session(ctx)
		if ctx.Err() != nil {
			return
		}
		if time.Since(started) > 30*time.Second {
			wait = minBackoff // сессия была нормальной — начинаем с короткой паузы
		}
		delay := jitter(wait)
		var ce websocket.CloseError
		switch {
		case errors.As(err, &ce) && ce.Code == proto.CloseKeyRevoked:
			c.Log.Error("ключ ноды отозван в панели; переустановите агент с новым токеном", "retry_in", fatalBackoff)
			delay = fatalBackoff
		case errors.As(err, &ce) && ce.Code == proto.CloseUnauthorized:
			c.Log.Error("панель не приняла ключ ноды", "retry_in", fatalBackoff)
			delay = fatalBackoff
		case errors.As(err, &ce) && ce.Code == proto.CloseProtocolMismatch:
			c.Log.Error("версия протокола не поддерживается панелью; обновите агент", "reason", ce.Reason, "retry_in", fatalBackoff)
			delay = fatalBackoff
		case errors.As(err, &ce) && ce.Code == proto.CloseSuperseded:
			c.Log.Warn("соединение вытеснено другим экземпляром агента этой ноды")
		default:
			c.Log.Warn("соединение с панелью потеряно", "err", err, "retry_in", delay.Round(100*time.Millisecond))
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(delay):
		}
		if wait *= 2; wait > maxBackoff {
			wait = maxBackoff
		}
	}
}

func jitter(d time.Duration) time.Duration {
	return d + time.Duration(rand.Int63n(int64(d)/4+1))
}

func (c *Client) session(ctx context.Context) error {
	url, err := c.Cfg.WSURL()
	if err != nil {
		return err
	}
	dctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	conn, resp, err := websocket.Dial(dctx, url, &websocket.DialOptions{
		HTTPHeader: http.Header{"Authorization": {"Bearer " + c.Key}, "User-Agent": {"popug-agent/" + c.Version}},
	})
	cancel()
	if err != nil {
		if resp != nil {
			switch resp.StatusCode {
			case http.StatusUnauthorized, http.StatusForbidden:
				return websocket.CloseError{Code: proto.CloseUnauthorized, Reason: "HTTP " + resp.Status}
			}
			return fmt.Errorf("HTTP %s: %w", resp.Status, err)
		}
		return err
	}
	defer conn.CloseNow()
	conn.SetReadLimit(readLimit)

	if err := c.writeJSON(ctx, conn, c.hello(ctx)); err != nil {
		return err
	}
	// Ждём welcome; без него метрики не шлём.
	wctx, wcancel := context.WithTimeout(ctx, 15*time.Second)
	_, data, err := conn.Read(wctx)
	wcancel()
	if err != nil {
		return fmt.Errorf("ожидание welcome: %w", err)
	}
	var w proto.Welcome
	if err := json.Unmarshal(data, &w); err != nil || w.T != "welcome" {
		_ = conn.Close(websocket.StatusCode(proto.CloseBadFrame), "ожидался welcome")
		return fmt.Errorf("вместо welcome пришло %.80q", data)
	}
	interval := time.Duration(w.MetricsIntervalSec) * time.Second
	if interval < 5*time.Second {
		interval = 15 * time.Second
	}
	c.upd.MarkHealthy() // если это первый запуск после обновления, новая версия подтверждена
	c.Log.Info("подключено к панели", "node", w.NodeID, "interval", interval, "protocol", w.Protocol)

	sctx, scancel := context.WithCancel(ctx)
	defer scancel()
	errc := make(chan error, 3)
	go func() { errc <- c.sendMetrics(sctx, conn, interval) }()
	go func() { errc <- c.readLoop(sctx, conn) }()
	go func() {
		errc <- c.checks.Loop(sctx, func(m proto.Checks) error { return c.writeJSON(sctx, conn, m) })
	}()
	err = <-errc
	scancel()
	_ = conn.Close(websocket.StatusNormalClosure, "")
	return err
}

func (c *Client) writeJSON(ctx context.Context, conn *websocket.Conn, v any) error {
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	wctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	return conn.Write(wctx, websocket.MessageText, b)
}

func (c *Client) sendMetrics(ctx context.Context, conn *websocket.Conn, interval time.Duration) error {
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		if err := c.writeJSON(ctx, conn, c.collect(ctx)); err != nil {
			return err
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-t.C:
		}
	}
}

func (c *Client) readLoop(ctx context.Context, conn *websocket.Conn) error {
	for {
		_, data, err := conn.Read(ctx)
		if err != nil {
			return err
		}
		var env proto.Envelope
		if json.Unmarshal(data, &env) != nil {
			return websocket.CloseError{Code: websocket.StatusCode(proto.CloseBadFrame), Reason: "bad frame"}
		}
		if env.T == "checks_config" {
			var cc proto.ChecksConfig
			if err := json.Unmarshal(data, &cc); err == nil {
				c.checks.SetConfig(cc)
			}
			continue
		}
		if env.T != "cmd" {
			continue // неизвестные типы игнорируем: совместимость вперёд
		}
		var cmd proto.Cmd
		if err := json.Unmarshal(data, &cmd); err != nil {
			continue
		}
		// Команды выполняются в отдельной горутине, чтобы не задерживать чтение.
		go func() {
			cctx, cancel := context.WithTimeout(ctx, 60*time.Second)
			defer cancel()
			res := c.ops.Handle(cctx, cmd)
			if err := c.writeJSON(ctx, conn, res); err != nil {
				c.Log.Warn("не удалось отправить результат команды", "op", cmd.Op, "err", err)
			}
		}()
	}
}

// Collect снимает один набор метрик (и для `popug-agent check`).
func (c *Client) Collect() proto.Metrics { return c.collect(context.Background()) }

func (c *Client) collect(ctx context.Context) proto.Metrics {
	c.seq++
	m := proto.Metrics{T: "metrics", Ts: time.Now().UnixMilli(), Seq: c.seq}
	cctx, cancel := context.WithTimeout(ctx, 12*time.Second)
	defer cancel()
	if sys, err := c.sys.Collect(); err != nil {
		c.Log.Warn("не удалось прочитать /proc", "err", err)
	} else {
		m.Sys = sys
	}
	snap := c.hap.Snapshot(cctx, c.Cfg.TopClients)
	m.HAProxy, m.Clients, m.ClientsError = snap.HAProxy, snap.Clients, snap.ClientsError
	if m.Sys.Net.Ifaces == nil {
		m.Sys.Net.Ifaces = []proto.Iface{}
	}
	return m
}

func (c *Client) hello(ctx context.Context) proto.Hello {
	host, _ := os.Hostname()
	return proto.Hello{
		T: "hello", Protocol: proto.Version, AgentVersion: c.Version,
		Hostname: host, OS: osName(), Arch: runtime.GOARCH,
		HAProxy: haproxy.Detect(ctx), Ops: proto.SupportedOps, Addrs: publicAddrs(), ConfigSha256: c.configSha(), UpdateReady: c.upd.PubKey != nil,
	}
}

func (c *Client) configSha() *string {
	b, err := os.ReadFile(c.Cfg.HAProxyConfig)
	if err != nil {
		return nil
	}
	h := sha256.Sum256(b)
	s := hex.EncodeToString(h[:])
	return &s
}

func osName() string {
	b, err := os.ReadFile("/etc/os-release")
	if err != nil {
		return runtime.GOOS
	}
	for _, line := range strings.Split(string(b), "\n") {
		if v, ok := strings.CutPrefix(line, "PRETTY_NAME="); ok {
			return strings.Trim(v, `"`)
		}
	}
	return runtime.GOOS
}

func publicAddrs() []string {
	out := []string{}
	addrs, err := net.InterfaceAddrs()
	if err != nil {
		return out
	}
	for _, a := range addrs {
		ipn, ok := a.(*net.IPNet)
		if !ok {
			continue
		}
		ip, ok := netip.AddrFromSlice(ipn.IP)
		if !ok {
			continue
		}
		ip = ip.Unmap()
		if ip.IsGlobalUnicast() && !ip.IsPrivate() && !isCGNAT(ip) {
			out = append(out, ip.String())
		}
		if len(out) >= 16 {
			break
		}
	}
	return out
}

var cgnat = netip.MustParsePrefix("100.64.0.0/10")

func isCGNAT(ip netip.Addr) bool { return cgnat.Contains(ip) }
