package config

import (
	"os"
	"path/filepath"
	"testing"
)

func TestWSURL(t *testing.T) {
	cases := map[string]string{
		"https://panel.example.com":     "wss://panel.example.com/ws/agent",
		"https://panel.example.com/":    "wss://panel.example.com/ws/agent",
		"http://127.0.0.1:3000":         "ws://127.0.0.1:3000/ws/agent",
		"https://example.com/sub/path/": "wss://example.com/sub/path/ws/agent",
	}
	for in, want := range cases {
		c := Default()
		c.PanelURL = in
		got, err := c.WSURL()
		if err != nil || got != want {
			t.Errorf("%s → %s (%v), ждали %s", in, got, err, want)
		}
	}
}

func TestValidate(t *testing.T) {
	c := Default()
	for _, bad := range []string{"", "panel.example.com", "ftp://x"} {
		c.PanelURL = bad
		if c.Validate() == nil {
			t.Errorf("%q должен быть невалиден", bad)
		}
	}
}

func TestKeyPermissions(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "key")
	if err := SaveKey(p, "nk_secret"); err != nil {
		t.Fatal(err)
	}
	if k, err := ReadKey(p); err != nil || k != "nk_secret" {
		t.Fatalf("%q %v", k, err)
	}
	if err := os.Chmod(p, 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := ReadKey(p); err == nil {
		t.Fatal("ключ с правами 644 должен отвергаться")
	}
	if _, err := ReadKey(filepath.Join(dir, "none")); err == nil {
		t.Fatal("отсутствующий ключ — ошибка")
	}
}

func TestSaveLoadRoundtrip(t *testing.T) {
	p := filepath.Join(t.TempDir(), "sub", "config.json")
	c := Default()
	c.PanelURL = "https://p.example.com"
	c.NodeID = "abc"
	if err := c.Save(p); err != nil {
		t.Fatal(err)
	}
	got, err := Load(p)
	if err != nil || got.NodeID != "abc" || got.StatsTable != "st_clients" {
		t.Fatalf("%+v %v", got, err)
	}
}
