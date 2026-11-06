package client

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"

	"popug-bridges/agent/internal/config"
	"popug-bridges/agent/internal/proto"
)

func testClient(t *testing.T, serverURL, key, cfgPath string) *Client {
	t.Helper()
	cfg := config.Default()
	cfg.PanelURL = serverURL
	cfg.HAProxySocket = filepath.Join(t.TempDir(), "none.sock") // сокета нет → haproxy.ok=false
	cfg.HAProxyConfig = cfgPath
	return New(cfg, key, "test", slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelError})))
}

func TestSessionHandshakeMetricsAndCommands(t *testing.T) {
	cfgFile := filepath.Join(t.TempDir(), "haproxy.cfg")
	os.WriteFile(cfgFile, []byte("global\n"), 0o644)

	var gotAuth atomic.Value
	done := make(chan string, 8)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth.Store(r.Header.Get("Authorization"))
		conn, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		defer conn.CloseNow()
		ctx := r.Context()
		_, data, err := conn.Read(ctx)
		if err != nil {
			return
		}
		var h proto.Hello
		if json.Unmarshal(data, &h) != nil || h.T != "hello" || h.Protocol != proto.Version {
			done <- "bad hello"
			return
		}
		// до welcome метрики приходить не должны — проверяем порядок на стороне агента
		wb, _ := json.Marshal(proto.Welcome{T: "welcome", Protocol: 1, NodeID: "n1", MetricsIntervalSec: 5})
		conn.Write(ctx, websocket.MessageText, wb)

		_, data, err = conn.Read(ctx)
		if err != nil {
			return
		}
		var m proto.Metrics
		if json.Unmarshal(data, &m) != nil || m.T != "metrics" || m.HAProxy.OK || m.HAProxy.Error == nil {
			done <- "bad metrics: " + string(data)
			return
		}
		// Разрешённая и запрещённая команды.
		conn.Write(ctx, websocket.MessageText, []byte(`{"t":"cmd","id":"a","op":"get_config"}`))
		conn.Write(ctx, websocket.MessageText, []byte(`{"t":"cmd","id":"b","op":"exec","args":{"cmd":"id"}}`))
		for i := 0; i < 2; i++ {
			_, data, err = conn.Read(ctx)
			if err != nil {
				return
			}
			var r struct {
				ID    string  `json:"id"`
				OK    bool    `json:"ok"`
				Error *string `json:"error"`
			}
			json.Unmarshal(data, &r)
			switch r.ID {
			case "a":
				if !r.OK {
					done <- "get_config failed"
					return
				}
			case "b":
				if r.OK || r.Error == nil || !strings.HasPrefix(*r.Error, "unsupported_op") {
					done <- "exec accepted"
					return
				}
			}
		}
		done <- "ok"
	}))
	defer srv.Close()

	c := testClient(t, srv.URL, "nk_test", cfgFile)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	go c.Run(ctx)

	select {
	case res := <-done:
		if res != "ok" {
			t.Fatal(res)
		}
	case <-ctx.Done():
		t.Fatal("таймаут")
	}
	if gotAuth.Load() != "Bearer nk_test" {
		t.Fatalf("Authorization = %v", gotAuth.Load())
	}
}

func TestReconnectsAfterDrop(t *testing.T) {
	var conns atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conns.Add(1)
		conn, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		conn.Close(websocket.StatusGoingAway, "restart") // сразу рвём
	}))
	defer srv.Close()
	c := testClient(t, srv.URL, "k", "/x")
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	go c.Run(ctx)
	deadline := time.After(4 * time.Second)
	for conns.Load() < 2 {
		select {
		case <-deadline:
			t.Fatalf("переподключений не было: %d", conns.Load())
		case <-time.After(50 * time.Millisecond):
		}
	}
}

func TestUnauthorizedIsReportedAsFatal(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "no", http.StatusUnauthorized)
	}))
	defer srv.Close()
	c := testClient(t, srv.URL, "bad", "/x")
	err := c.session(context.Background())
	var ce websocket.CloseError
	if err == nil || !strings.Contains(err.Error(), "401") && !asClose(err, &ce) {
		t.Fatalf("err = %v", err)
	}
}

func asClose(err error, ce *websocket.CloseError) bool {
	if v, ok := err.(websocket.CloseError); ok {
		*ce = v
		return v.Code == proto.CloseUnauthorized
	}
	return false
}

func TestEnroll(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req proto.EnrollRequest
		json.NewDecoder(r.Body).Decode(&req)
		if r.URL.Path != "/api/agent/enroll" || req.Token != "good-token-good-token" {
			w.WriteHeader(http.StatusForbidden)
			w.Write([]byte(`{"error":"invalid_token","message":"токен не найден или использован"}`))
			return
		}
		json.NewEncoder(w).Encode(proto.EnrollResponse{NodeID: "n1", Key: "nk_abc"})
	}))
	defer srv.Close()
	r, err := Enroll(context.Background(), srv.URL, "good-token-good-token", "t", "h")
	if err != nil || r.Key != "nk_abc" || r.NodeID != "n1" {
		t.Fatalf("%+v %v", r, err)
	}
	_, err = Enroll(context.Background(), srv.URL, "wrong-token-wrong-token", "t", "h")
	if err == nil || !strings.Contains(err.Error(), "токен не найден") {
		t.Fatalf("err = %v", err)
	}
}
