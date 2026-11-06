// Package checks — проверки «агент → выход»: TCP-коннект и TLS ClientHello с SNI маршрута.
// Это то, что сделает клиент Reality до проверки ключей: если выход жив и отдаёт рукопожатие, проба успешна.
package checks

import (
	"context"
	"crypto/tls"
	"fmt"
	"net"
	"strconv"
	"sync"
	"time"

	"popug-bridges/agent/internal/proto"
)

const (
	connectTimeout   = 4 * time.Second
	handshakeTimeout = 6 * time.Second
	maxParallel      = 10
)

// proxyV2Local — заголовок PROXY protocol v2 с командой LOCAL: так HAProxy проверяет бэкенды.
// Получатель с acceptProxyProtocol принимает его без подмены адреса клиента.
var proxyV2Local = []byte{0x0D, 0x0A, 0x0D, 0x0A, 0x00, 0x0D, 0x0A, 0x51, 0x55, 0x49, 0x54, 0x0A, 0x20, 0x00, 0x00, 0x00}

// Probe проверяет один выход. Никогда не паникует и не блокируется дольше ~10 с.
func Probe(ctx context.Context, t proto.CheckTarget) proto.CheckResult {
	res := proto.CheckResult{RouteID: t.RouteID, ExitID: t.ExitID}
	fail := func(err error) proto.CheckResult {
		msg := err.Error()
		if len(msg) > 300 {
			msg = msg[:300]
		}
		res.Error = &msg
		return res
	}
	start := time.Now()
	d := net.Dialer{Timeout: connectTimeout}
	conn, err := d.DialContext(ctx, "tcp", net.JoinHostPort(t.Host, strconv.Itoa(t.Port)))
	if err != nil {
		return fail(err)
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(handshakeTimeout))
	if t.Proxy {
		if _, err := conn.Write(proxyV2Local); err != nil {
			return fail(err)
		}
	}
	tc := tls.Client(conn, &tls.Config{
		ServerName:         t.SNI,
		InsecureSkipVerify: true, // сертификат не важен: проверяем только что выход отвечает рукопожатием
		MinVersion:         tls.VersionTLS12,
	})
	if err := tc.HandshakeContext(ctx); err != nil {
		return fail(fmt.Errorf("TLS: %w", err))
	}
	ms := float64(time.Since(start).Microseconds()) / 1000
	res.OK, res.Ms = true, &ms
	return res
}

// Runner хранит текущий список целей и гоняет проверки.
type Runner struct {
	mu       sync.Mutex
	targets  []proto.CheckTarget
	interval time.Duration
	update   chan struct{}
	Probe    func(context.Context, proto.CheckTarget) proto.CheckResult
}

func NewRunner() *Runner {
	return &Runner{interval: 30 * time.Second, update: make(chan struct{}, 1), Probe: Probe}
}

func (r *Runner) SetConfig(c proto.ChecksConfig) {
	r.mu.Lock()
	r.targets = append([]proto.CheckTarget(nil), c.Targets...)
	if c.IntervalSec >= 10 {
		r.interval = time.Duration(c.IntervalSec) * time.Second
	}
	r.mu.Unlock()
	select {
	case r.update <- struct{}{}: // изменение конфига — сразу прогон
	default:
	}
}

func (r *Runner) snapshot() ([]proto.CheckTarget, time.Duration) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]proto.CheckTarget(nil), r.targets...), r.interval
}

// RunOnce проверяет все цели параллельно (не больше maxParallel одновременно).
func (r *Runner) RunOnce(ctx context.Context) []proto.CheckResult {
	targets, _ := r.snapshot()
	out := make([]proto.CheckResult, len(targets))
	sem := make(chan struct{}, maxParallel)
	var wg sync.WaitGroup
	for i, t := range targets {
		wg.Add(1)
		sem <- struct{}{}
		go func() {
			defer wg.Done()
			defer func() { <-sem }()
			out[i] = r.Probe(ctx, t)
		}()
	}
	wg.Wait()
	return out
}

// Loop гоняет проверки по расписанию и отдаёт результаты в send, пока жив ctx.
func (r *Runner) Loop(ctx context.Context, send func(proto.Checks) error) error {
	for {
		if targets, _ := r.snapshot(); len(targets) > 0 {
			if err := send(proto.Checks{T: "checks", Ts: time.Now().UnixMilli(), Results: r.RunOnce(ctx)}); err != nil {
				return err
			}
		}
		_, interval := r.snapshot()
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-r.update:
		case <-time.After(interval):
		}
	}
}
