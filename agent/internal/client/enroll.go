package client

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"popug-bridges/agent/internal/proto"
)

// Enroll обменивает одноразовый токен на постоянный ключ ноды.
func Enroll(ctx context.Context, panelURL, token, version, hostname string) (proto.EnrollResponse, error) {
	var out proto.EnrollResponse
	body, _ := json.Marshal(proto.EnrollRequest{Token: token, Protocol: proto.Version, AgentVersion: version, Hostname: hostname})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimRight(panelURL, "/")+"/api/agent/enroll", bytes.NewReader(body))
	if err != nil {
		return out, err
	}
	req.Header.Set("Content-Type", "application/json")
	hc := &http.Client{
		Timeout:       20 * time.Second,
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
	resp, err := hc.Do(req)
	if err != nil {
		return out, fmt.Errorf("панель недоступна: %w", err)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(io.LimitReader(resp.Body, 64<<10))
	if resp.StatusCode != http.StatusOK {
		var e struct {
			Error   string `json:"error"`
			Message string `json:"message"`
		}
		_ = json.Unmarshal(b, &e)
		msg := e.Message
		if msg == "" {
			msg = strings.TrimSpace(string(b))
		}
		return out, fmt.Errorf("панель отказала в регистрации (HTTP %d): %s", resp.StatusCode, msg)
	}
	if err := json.Unmarshal(b, &out); err != nil || out.Key == "" || out.NodeID == "" {
		return out, fmt.Errorf("неожиданный ответ панели")
	}
	return out, nil
}
