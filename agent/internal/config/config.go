// Package config — локальная конфигурация агента и хранение ключа ноды.
package config

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"net/url"
	"os"
	"path/filepath"
	"strings"
)

const (
	DefaultDir        = "/etc/popug-agent"
	DefaultConfigPath = DefaultDir + "/config.json"
)

type Config struct {
	PanelURL      string `json:"panelUrl"`
	NodeID        string `json:"nodeId"`
	KeyFile       string `json:"keyFile"`
	HAProxySocket string `json:"haproxySocket"`
	StatsTable    string `json:"statsTable"`
	HAProxyConfig string `json:"haproxyConfig"`
	HAProxyMap    string `json:"haproxyMap"`
	BackupDir     string `json:"backupDir"`
	StateDir      string `json:"stateDir"`
	UpdateKeyFile string `json:"updateKeyFile"`
	TopClients    int    `json:"topClients"`
}

func Default() Config {
	return Config{
		KeyFile:       DefaultDir + "/key",
		HAProxySocket: "/run/haproxy/admin.sock",
		StatsTable:    "st_clients",
		HAProxyConfig: "/etc/haproxy/haproxy.cfg",
		HAProxyMap:    "/etc/haproxy/maps/sni.map",
		BackupDir:     "/var/lib/popug-agent/backups",
		StateDir:      "/var/lib/popug-agent",
		UpdateKeyFile: "/etc/popug-agent/update.pub",
		TopClients:    50,
	}
}

func Load(path string) (Config, error) {
	c := Default()
	b, err := os.ReadFile(path)
	if err != nil {
		return c, err
	}
	if err := json.Unmarshal(b, &c); err != nil {
		return c, fmt.Errorf("%s: %w", path, err)
	}
	return c, c.Validate()
}

func (c Config) Validate() error {
	u, err := url.Parse(c.PanelURL)
	if err != nil || u.Host == "" || (u.Scheme != "https" && u.Scheme != "http") {
		return fmt.Errorf("panelUrl %q: нужен адрес вида https://panel.example.com", c.PanelURL)
	}
	if c.TopClients < 1 || c.TopClients > 100 {
		return fmt.Errorf("topClients должен быть от 1 до 100")
	}
	return nil
}

// WSURL превращает panelUrl в адрес WebSocket-эндпоинта агента.
func (c Config) WSURL() (string, error) {
	u, err := url.Parse(strings.TrimRight(c.PanelURL, "/"))
	if err != nil {
		return "", err
	}
	switch u.Scheme {
	case "https":
		u.Scheme = "wss"
	case "http":
		u.Scheme = "ws"
	default:
		return "", fmt.Errorf("схема %q не поддерживается", u.Scheme)
	}
	u.Path = strings.TrimRight(u.Path, "/") + "/ws/agent"
	return u.String(), nil
}

// Save пишет конфиг атомарно (0644: в нём нет секретов, ключ лежит отдельно).
func (c Config) Save(path string) error {
	b, err := json.MarshalIndent(c, "", "  ")
	if err != nil {
		return err
	}
	return writeAtomic(path, append(b, '\n'), 0o644)
}

// ReadKey читает ключ ноды и отказывается работать, если права шире 0600.
func ReadKey(path string) (string, error) {
	st, err := os.Stat(path)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return "", fmt.Errorf("ключ ноды не найден (%s): выполните popug-agent enroll", path)
		}
		return "", err
	}
	if st.Mode().Perm()&0o077 != 0 {
		return "", fmt.Errorf("права %s слишком широкие (%o), нужны 600", path, st.Mode().Perm())
	}
	b, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	k := strings.TrimSpace(string(b))
	if k == "" {
		return "", fmt.Errorf("файл ключа %s пуст", path)
	}
	return k, nil
}

func SaveKey(path, key string) error { return writeAtomic(path, []byte(key+"\n"), 0o600) }

func writeAtomic(path string, data []byte, mode os.FileMode) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), ".tmp-*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if err := tmp.Chmod(mode); err != nil {
		tmp.Close()
		return err
	}
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), path)
}
