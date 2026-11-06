// Package bans держит nft-таблицу inet popug_bans с таймаутами: заблокированный IP клиента отбрасывается
// ещё до HAProxy. Команды фиксированы (nft, ss, conntrack), IP проходят строгий разбор — произвольных
// строк в nft не попадает.
package bans

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/netip"
	"os/exec"
	"sort"
	"strings"
	"sync"
	"time"

	"popug-bridges/agent/internal/proto"
)

const Table = "popug_bans"

// Runner запускает фиксированные программы; в тестах подменяется.
type Runner interface {
	Run(ctx context.Context, stdin, name string, args ...string) ([]byte, error)
}

var allowed = map[string]bool{"nft": true, "ss": true, "conntrack": true}

type ExecRunner struct{}

func (ExecRunner) Run(ctx context.Context, stdin, name string, args ...string) ([]byte, error) {
	if !allowed[name] {
		return nil, fmt.Errorf("команда %q не разрешена", name)
	}
	cctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	cmd := exec.CommandContext(cctx, name, args...)
	if stdin != "" {
		cmd.Stdin = strings.NewReader(stdin)
	}
	return cmd.CombinedOutput()
}

type Manager struct {
	Run   Runner
	Local func() []netip.Addr // адреса самого моста: банить их нельзя
	mu    sync.Mutex
}

func New(run Runner) *Manager { return &Manager{Run: run, Local: localAddrs} }

func localAddrs() []netip.Addr {
	var out []netip.Addr
	addrs, _ := net.InterfaceAddrs()
	for _, a := range addrs {
		if ipn, ok := a.(*net.IPNet); ok {
			if ip, ok := netip.AddrFromSlice(ipn.IP); ok {
				out = append(out, ip.Unmap())
			}
		}
	}
	return out
}

// Protected объясняет, почему IP банить нельзя; пустая строка — можно.
func (m *Manager) Protected(ip netip.Addr) string {
	switch {
	case ip.IsLoopback():
		return "loopback"
	case ip.IsPrivate():
		return "частный адрес"
	case ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast():
		return "link-local"
	case ip.IsMulticast():
		return "multicast"
	case ip.IsUnspecified():
		return "неопределённый адрес"
	}
	if m.Local != nil {
		for _, l := range m.Local() {
			if l == ip {
				return "адрес самого моста"
			}
		}
	}
	return ""
}

type entry struct {
	ip  netip.Addr
	ttl time.Duration
}

func setFor(ip netip.Addr) string {
	if ip.Is4() {
		return "banned4"
	}
	return "banned6"
}

func secs(d time.Duration) int64 {
	s := int64((d + time.Second - 1) / time.Second)
	if s < 1 {
		s = 1
	}
	return s
}

// RenderTable — nft-скрипт, атомарно пересоздающий таблицу с набором банов.
func RenderTable(entries []entry) string {
	var v4, v6 []string
	sorted := append([]entry(nil), entries...)
	sort.Slice(sorted, func(i, j int) bool { return sorted[i].ip.Less(sorted[j].ip) })
	for _, e := range sorted {
		el := fmt.Sprintf("%s timeout %ds", e.ip, secs(e.ttl))
		if e.ip.Is4() {
			v4 = append(v4, el)
		} else {
			v6 = append(v6, el)
		}
	}
	set := func(name, typ string, els []string) string {
		s := fmt.Sprintf("  set %s {\n    type %s\n    flags timeout\n", name, typ)
		if len(els) > 0 {
			s += "    elements = { " + strings.Join(els, ", ") + " }\n"
		}
		return s + "  }\n"
	}
	return fmt.Sprintf(`add table inet %[1]s
delete table inet %[1]s
table inet %[1]s {
%[2]s%[3]s  chain input {
    type filter hook input priority -10; policy accept;
    ip saddr @banned4 counter drop
    ip6 saddr @banned6 counter drop
  }
}
`, Table, set("banned4", "ipv4_addr", v4), set("banned6", "ipv6_addr", v6))
}

// Apply выполняет операцию apply_bans. Результат всегда заполнен.
func (m *Manager) Apply(ctx context.Context, a proto.BansArgs) (proto.BansResult, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	res := proto.BansResult{Rejected: []proto.BansRejected{}}
	reject := func(ip, why string) { res.Rejected = append(res.Rejected, proto.BansRejected{IP: ip, Reason: why}) }

	var add []entry
	for _, b := range a.Ban {
		ip, err := netip.ParseAddr(strings.TrimSpace(b.IP))
		if err != nil {
			reject(b.IP, "не IP-адрес")
			continue
		}
		ip = ip.Unmap().WithZone("")
		if why := m.Protected(ip); why != "" {
			reject(b.IP, why)
			continue
		}
		if b.TTLSec < 1 {
			reject(b.IP, "срок меньше секунды")
			continue
		}
		add = append(add, entry{ip, time.Duration(b.TTLSec) * time.Second})
	}

	if a.Full {
		if out, err := m.Run.Run(ctx, RenderTable(add), "nft", "-f", "-"); err != nil {
			return res, fmt.Errorf("nft: %v: %s", err, strings.TrimSpace(string(out)))
		}
		res.Active = len(add)
		return res, nil
	}

	if _, err := m.Run.Run(ctx, "", "nft", "list", "table", "inet", Table); err != nil {
		if out, err := m.Run.Run(ctx, RenderTable(nil), "nft", "-f", "-"); err != nil {
			return res, fmt.Errorf("nft: не удалось создать таблицу: %v: %s", err, strings.TrimSpace(string(out)))
		}
	}
	for _, s := range a.Unban {
		ip, err := netip.ParseAddr(strings.TrimSpace(s))
		if err != nil {
			reject(s, "не IP-адрес")
			continue
		}
		ip = ip.Unmap().WithZone("")
		// «нет такого элемента» — не ошибка: бан уже истёк
		_, _ = m.Run.Run(ctx, "", "nft", "delete", "element", "inet", Table, setFor(ip), "{ "+ip.String()+" }")
	}
	for _, e := range add {
		set := setFor(e.ip)
		_, _ = m.Run.Run(ctx, "", "nft", "delete", "element", "inet", Table, set, "{ "+e.ip.String()+" }") // чтобы новый срок победил
		if out, err := m.Run.Run(ctx, "", "nft", "add", "element", "inet", Table, set, fmt.Sprintf("{ %s timeout %ds }", e.ip, secs(e.ttl))); err != nil {
			reject(e.ip.String(), fmt.Sprintf("nft: %s", strings.TrimSpace(string(out))))
			continue
		}
		m.kill(ctx, e.ip)
	}
	res.Active = m.count(ctx)
	return res, nil
}

// kill рвёт уже установленные соединения IP; как fallback — conntrack.
func (m *Manager) kill(ctx context.Context, ip netip.Addr) {
	if _, err := m.Run.Run(ctx, "", "ss", "-K", "dst", ip.String()); err == nil {
		return
	}
	_, _ = m.Run.Run(ctx, "", "conntrack", "-D", "-s", ip.String())
}

func (m *Manager) count(ctx context.Context) int {
	total := 0
	for _, set := range []string{"banned4", "banned6"} {
		out, err := m.Run.Run(ctx, "", "nft", "-j", "list", "set", "inet", Table, set)
		if err != nil {
			continue
		}
		var doc struct {
			Nftables []struct {
				Set *struct {
					Elem []json.RawMessage `json:"elem"`
				} `json:"set"`
			} `json:"nftables"`
		}
		if json.Unmarshal(out, &doc) == nil {
			for _, n := range doc.Nftables {
				if n.Set != nil {
					total += len(n.Set.Elem)
				}
			}
		}
	}
	return total
}
