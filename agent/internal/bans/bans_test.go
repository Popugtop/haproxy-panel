package bans

import (
	"context"
	"errors"
	"net/netip"
	"strings"
	"testing"
	"time"

	"popug-bridges/agent/internal/proto"
)

type call struct{ stdin, name, args string }

type fake struct {
	calls     []call
	tableOK   bool
	failAdd   map[string]bool
	ssFails   bool
	setOutput string
}

func (f *fake) Run(_ context.Context, stdin, name string, args ...string) ([]byte, error) {
	a := strings.Join(args, " ")
	f.calls = append(f.calls, call{stdin, name, a})
	switch {
	case name == "nft" && strings.HasPrefix(a, "list table"):
		if !f.tableOK {
			return []byte("Error: No such file or directory"), errors.New("exit 1")
		}
	case name == "nft" && strings.HasPrefix(a, "add element"):
		for ip := range f.failAdd {
			if strings.Contains(a, ip) {
				return []byte("Error: bad"), errors.New("exit 1")
			}
		}
	case name == "nft" && strings.HasPrefix(a, "-j list set"):
		return []byte(f.setOutput), nil
	case name == "ss":
		if f.ssFails {
			return nil, errors.New("not supported")
		}
	}
	return nil, nil
}

func (f *fake) has(name, prefix string) bool {
	for _, c := range f.calls {
		if c.name == name && strings.HasPrefix(c.args, prefix) {
			return true
		}
	}
	return false
}

func mgr(f *fake) *Manager {
	m := New(f)
	m.Local = func() []netip.Addr { return []netip.Addr{netip.MustParseAddr("203.0.113.5")} }
	return m
}

func TestRenderTable(t *testing.T) {
	got := RenderTable([]entry{
		{netip.MustParseAddr("198.51.100.9"), 90 * time.Minute},
		{netip.MustParseAddr("198.51.100.7"), 1500 * time.Millisecond},
		{netip.MustParseAddr("2001:db8::5"), time.Hour},
	})
	for _, want := range []string{
		"add table inet popug_bans\ndelete table inet popug_bans\ntable inet popug_bans {",
		"elements = { 198.51.100.7 timeout 2s, 198.51.100.9 timeout 5400s }", // отсортировано, миллисекунды вверх
		"elements = { 2001:db8::5 timeout 3600s }",
		"type filter hook input priority -10; policy accept;",
		"ip saddr @banned4 counter drop",
		"ip6 saddr @banned6 counter drop",
	} {
		if !strings.Contains(got, want) {
			t.Errorf("нет %q в:\n%s", want, got)
		}
	}
	empty := RenderTable(nil)
	if strings.Contains(empty, "elements") {
		t.Errorf("пустой набор не должен содержать elements:\n%s", empty)
	}
}

func TestFullSyncReplacesTableAtomically(t *testing.T) {
	f := &fake{}
	res, err := mgr(f).Apply(context.Background(), proto.BansArgs{Full: true, Ban: []proto.BanItem{{IP: "198.51.100.7", TTLSec: 3600}, {IP: "::ffff:198.51.100.8", TTLSec: 60}}})
	if err != nil || res.Active != 2 || len(res.Rejected) != 0 {
		t.Fatalf("%+v %v", res, err)
	}
	if len(f.calls) != 1 || f.calls[0].name != "nft" || f.calls[0].args != "-f -" {
		t.Fatalf("полная синхронизация — один nft -f -: %+v", f.calls)
	}
	if !strings.Contains(f.calls[0].stdin, "198.51.100.8 timeout 60s") { // IPv4-mapped разворачивается в v4
		t.Fatalf("mapped-адрес не развёрнут:\n%s", f.calls[0].stdin)
	}
}

func TestProtectedAddressesAreRejected(t *testing.T) {
	f := &fake{tableOK: true}
	bad := []string{"127.0.0.1", "10.1.2.3", "192.168.1.1", "172.16.0.9", "169.254.1.1", "224.0.0.1", "0.0.0.0", "::1", "fe80::1", "203.0.113.5", "not-an-ip", "1.2.3.4; rm -rf /", ""}
	var items []proto.BanItem
	for _, ip := range bad {
		items = append(items, proto.BanItem{IP: ip, TTLSec: 60})
	}
	res, err := mgr(f).Apply(context.Background(), proto.BansArgs{Ban: items})
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Rejected) != len(bad) {
		t.Fatalf("отклонено %d из %d: %+v", len(res.Rejected), len(bad), res.Rejected)
	}
	if f.has("nft", "add element") {
		t.Fatal("защищённые адреса попали в nft")
	}
	for _, c := range f.calls {
		if strings.Contains(c.args, "rm -rf") || strings.Contains(c.stdin, "rm -rf") {
			t.Fatal("мусор дошёл до команды")
		}
	}
}

func TestDeltaAddsRemovesAndKills(t *testing.T) {
	f := &fake{tableOK: true, setOutput: `{"nftables":[{"set":{"elem":[{"elem":{"val":"198.51.100.7"}},{"elem":{"val":"198.51.100.8"}}]}}]}`}
	res, err := mgr(f).Apply(context.Background(), proto.BansArgs{Ban: []proto.BanItem{{IP: "198.51.100.7", TTLSec: 600}}, Unban: []string{"198.51.100.9"}})
	if err != nil {
		t.Fatal(err)
	}
	if !f.has("nft", "delete element inet popug_bans banned4 { 198.51.100.9 }") {
		t.Fatalf("нет удаления: %+v", f.calls)
	}
	if !f.has("nft", "add element inet popug_bans banned4 { 198.51.100.7 timeout 600s }") {
		t.Fatalf("нет добавления: %+v", f.calls)
	}
	if !f.has("ss", "-K dst 198.51.100.7") {
		t.Fatal("соединения не разорваны")
	}
	if res.Active != 4 { // по два элемента в каждом из двух наборов в ответе-заглушке
		t.Fatalf("active=%d", res.Active)
	}
}

func TestDeltaCreatesMissingTableAndFallsBackToConntrack(t *testing.T) {
	f := &fake{ssFails: true}
	_, err := mgr(f).Apply(context.Background(), proto.BansArgs{Ban: []proto.BanItem{{IP: "198.51.100.7", TTLSec: 60}}})
	if err != nil {
		t.Fatal(err)
	}
	if !f.has("nft", "-f -") {
		t.Fatal("таблица не создана")
	}
	if !f.has("conntrack", "-D -s 198.51.100.7") {
		t.Fatal("fallback на conntrack не сработал")
	}
}

func TestFailedAddIsReportedNotFatal(t *testing.T) {
	f := &fake{tableOK: true, failAdd: map[string]bool{"198.51.100.7": true}}
	res, err := mgr(f).Apply(context.Background(), proto.BansArgs{Ban: []proto.BanItem{{IP: "198.51.100.7", TTLSec: 60}, {IP: "198.51.100.8", TTLSec: 60}}})
	if err != nil || len(res.Rejected) != 1 || res.Rejected[0].IP != "198.51.100.7" {
		t.Fatalf("%+v %v", res, err)
	}
	if !f.has("nft", "add element inet popug_bans banned4 { 198.51.100.8 timeout 60s }") {
		t.Fatal("второй бан не применился после сбоя первого")
	}
}

func TestExecRunnerRefusesOtherPrograms(t *testing.T) {
	for _, name := range []string{"sh", "bash", "rm", "curl", "/bin/sh"} {
		if _, err := (ExecRunner{}).Run(context.Background(), "", name, "-c", "id"); err == nil {
			t.Errorf("%s не должен запускаться", name)
		}
	}
}
