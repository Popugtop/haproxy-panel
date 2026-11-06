package checks

import (
	"bytes"
	"context"
	"crypto/tls"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strconv"
	"sync/atomic"
	"testing"
	"time"

	"popug-bridges/agent/internal/proto"
)

func hostPort(t *testing.T, addr string) (string, int) {
	t.Helper()
	h, p, err := net.SplitHostPort(addr)
	if err != nil {
		t.Fatal(err)
	}
	n, _ := strconv.Atoi(p)
	return h, n
}

func TestProbeTLSServerOK(t *testing.T) {
	var gotSNI atomic.Value
	srv := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	srv.TLS = &tls.Config{GetConfigForClient: func(h *tls.ClientHelloInfo) (*tls.Config, error) {
		gotSNI.Store(h.ServerName)
		return nil, nil
	}}
	srv.StartTLS()
	defer srv.Close()
	h, p := hostPort(t, srv.Listener.Addr().String())

	res := Probe(context.Background(), proto.CheckTarget{RouteID: "r", ExitID: "e", Host: h, Port: p, SNI: "de.popug.cloud"})
	if !res.OK || res.Ms == nil || res.Error != nil || res.RouteID != "r" || res.ExitID != "e" {
		t.Fatalf("%+v", res)
	}
	if gotSNI.Load() != "de.popug.cloud" {
		t.Fatalf("сервер получил SNI %v", gotSNI.Load())
	}
}

func TestProbeConnectionRefused(t *testing.T) {
	l, _ := net.Listen("tcp", "127.0.0.1:0")
	h, p := hostPort(t, l.Addr().String())
	l.Close() // порт закрыт
	res := Probe(context.Background(), proto.CheckTarget{Host: h, Port: p, SNI: "x.example"})
	if res.OK || res.Ms != nil || res.Error == nil {
		t.Fatalf("%+v", res)
	}
}

func TestProbeNonTLSServerFails(t *testing.T) {
	l, _ := net.Listen("tcp", "127.0.0.1:0")
	defer l.Close()
	go func() {
		for {
			c, err := l.Accept()
			if err != nil {
				return
			}
			c.Write([]byte("SSH-2.0-OpenSSH\r\n")) // это не TLS
			c.Close()
		}
	}()
	h, p := hostPort(t, l.Addr().String())
	res := Probe(context.Background(), proto.CheckTarget{Host: h, Port: p, SNI: "x.example"})
	if res.OK || res.Error == nil {
		t.Fatalf("%+v", res)
	}
}

func TestProbeSendsProxyV2HeaderFirst(t *testing.T) {
	l, _ := net.Listen("tcp", "127.0.0.1:0")
	defer l.Close()
	first := make(chan []byte, 1)
	go func() {
		c, err := l.Accept()
		if err != nil {
			return
		}
		defer c.Close()
		buf := make([]byte, len(proxyV2Local))
		io.ReadFull(c, buf)
		first <- buf
	}()
	h, p := hostPort(t, l.Addr().String())
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	Probe(ctx, proto.CheckTarget{Host: h, Port: p, SNI: "x.example", Proxy: true})
	select {
	case b := <-first:
		if !bytes.Equal(b, proxyV2Local) {
			t.Fatalf("заголовок: % x", b)
		}
		// сигнатура + версия 2, команда LOCAL, без адресов
		if b[12] != 0x20 || b[13] != 0x00 || b[14] != 0 || b[15] != 0 {
			t.Fatalf("не LOCAL v2: % x", b[12:])
		}
	case <-time.After(3 * time.Second):
		t.Fatal("сервер не получил данных")
	}
}

func TestRunnerRunsTargetsInParallelAndKeepsOrder(t *testing.T) {
	r := NewRunner()
	var running, peak int32
	r.Probe = func(_ context.Context, t proto.CheckTarget) proto.CheckResult {
		n := atomic.AddInt32(&running, 1)
		for {
			p := atomic.LoadInt32(&peak)
			if n <= p || atomic.CompareAndSwapInt32(&peak, p, n) {
				break
			}
		}
		time.Sleep(30 * time.Millisecond)
		atomic.AddInt32(&running, -1)
		return proto.CheckResult{RouteID: t.RouteID, ExitID: t.ExitID, OK: true}
	}
	var ts []proto.CheckTarget
	for i := 0; i < 25; i++ {
		ts = append(ts, proto.CheckTarget{RouteID: "r" + strconv.Itoa(i), ExitID: "e"})
	}
	r.SetConfig(proto.ChecksConfig{IntervalSec: 30, Targets: ts})
	got := r.RunOnce(context.Background())
	if len(got) != 25 || got[0].RouteID != "r0" || got[24].RouteID != "r24" {
		t.Fatalf("порядок или размер: %d", len(got))
	}
	if peak < 2 || peak > maxParallel {
		t.Fatalf("параллелизм %d, ожидалось 2..%d", peak, maxParallel)
	}
}

func TestLoopSendsImmediatelyOnConfigUpdate(t *testing.T) {
	r := NewRunner()
	r.Probe = func(_ context.Context, t proto.CheckTarget) proto.CheckResult {
		return proto.CheckResult{RouteID: t.RouteID, ExitID: t.ExitID, OK: true}
	}
	sent := make(chan proto.Checks, 4)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go r.Loop(ctx, func(c proto.Checks) error { sent <- c; return nil })

	select {
	case <-sent:
		t.Fatal("без целей отправлять нечего")
	case <-time.After(150 * time.Millisecond):
	}
	r.SetConfig(proto.ChecksConfig{IntervalSec: 600, Targets: []proto.CheckTarget{{RouteID: "r", ExitID: "e"}}})
	select {
	case c := <-sent:
		if c.T != "checks" || len(c.Results) != 1 || !c.Results[0].OK {
			t.Fatalf("%+v", c)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("после SetConfig результаты должны уйти сразу, не ждать интервал")
	}
}
