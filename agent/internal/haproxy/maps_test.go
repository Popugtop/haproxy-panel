package haproxy

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func write(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestReadReferencedMaps(t *testing.T) {
	root := t.TempDir()
	hap := filepath.Join(root, "etc", "haproxy")
	cfg := filepath.Join(hap, "haproxy.cfg")
	write(t, cfg, "global\n")
	write(t, filepath.Join(hap, "sni.map"), "de.example.com be_de\n")
	write(t, filepath.Join(hap, "maps", "nested.map"), "nl.example.com be_nl\n")
	secret := filepath.Join(root, "secret.map")
	write(t, secret, "TOP SECRET\n")
	write(t, filepath.Join(hap, "certs", "key.pem"), "PRIVATE KEY")
	write(t, filepath.Join(hap, "notes.txt"), "not a map")
	write(t, filepath.Join(hap, "huge.map"), strings.Repeat("a b\n", 400_000))
	if err := os.Symlink(secret, filepath.Join(hap, "link.map")); err != nil {
		t.Fatal(err)
	}

	cfgText := `frontend fe
    use_backend %[req.ssl_sni,lower,map(` + filepath.Join(hap, "sni.map") + `)]
    use_backend %[req.ssl_sni,lower,map(` + filepath.Join(hap, "maps", "nested.map") + `,be_x)]
    use_backend %[req.ssl_sni,lower,map(` + filepath.Join(hap, "sni.map") + `)]
    http-request set-var(txn.a) req.hdr(host),map_str(` + secret + `)
    use_backend %[req.ssl_sni,map(` + filepath.Join(hap, "..", "..", "secret.map") + `)]
    use_backend %[req.ssl_sni,map(` + filepath.Join(hap, "link.map") + `)]
    use_backend %[req.ssl_sni,map(` + filepath.Join(hap, "certs", "key.pem") + `)]
    use_backend %[req.ssl_sni,map(` + filepath.Join(hap, "notes.txt") + `)]
    use_backend %[req.ssl_sni,map(` + filepath.Join(hap, "huge.map") + `)]
    use_backend %[req.ssl_sni,map(` + filepath.Join(hap, "missing.map") + `)]
    use_backend %[req.ssl_sni,map(relative/sni.map)]
    use_backend %[req.ssl_sni,map(/etc/shadow)]
`
	got := ReadReferencedMaps(cfg, cfgText)
	if len(got) != 2 {
		t.Fatalf("ожидалось 2 карты (внутри каталога конфига), получили %d: %+v", len(got), got)
	}
	byPath := map[string]string{}
	for _, m := range got {
		byPath[m.Path] = m.Content
	}
	if byPath[filepath.Join(hap, "sni.map")] != "de.example.com be_de\n" {
		t.Errorf("sni.map: %q", byPath[filepath.Join(hap, "sni.map")])
	}
	if byPath[filepath.Join(hap, "maps", "nested.map")] != "nl.example.com be_nl\n" {
		t.Errorf("nested.map: %q", byPath[filepath.Join(hap, "maps", "nested.map")])
	}
	for p, c := range byPath {
		if strings.Contains(c, "SECRET") || strings.Contains(c, "PRIVATE") {
			t.Errorf("утечка содержимого вне каталога конфига: %s", p)
		}
	}
}

func TestReadReferencedMapsLimitsFileCount(t *testing.T) {
	root := t.TempDir()
	cfg := filepath.Join(root, "haproxy.cfg")
	write(t, cfg, "global\n")
	var b strings.Builder
	for i := 0; i < 20; i++ {
		p := filepath.Join(root, "m"+string(rune('a'+i))+".map")
		write(t, p, "a b\n")
		b.WriteString("use_backend %[req.ssl_sni,map(" + p + ")]\n")
	}
	if n := len(ReadReferencedMaps(cfg, b.String())); n != maxMapFiles {
		t.Fatalf("ожидалось не больше %d карт, получили %d", maxMapFiles, n)
	}
}

func TestReadReferencedMapsNoConfigDir(t *testing.T) {
	if got := ReadReferencedMaps("/nonexistent/dir/haproxy.cfg", "map(/nonexistent/dir/a.map)"); got != nil {
		t.Fatalf("ожидался nil, получили %+v", got)
	}
}
