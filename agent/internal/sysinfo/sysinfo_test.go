package sysinfo

import (
	"math"
	"strings"
	"testing"
)

const netDev = `Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
    lo: 5000000   100    0    0    0     0          0         0  5000000   100    0    0    0     0       0          0
  eth0: 912345678901 8000000    0    0    0     0          0         0 934567890123 7000000    0    0    0     0       0          0
docker0:  111      1    0    0    0     0          0         0  222      2    0    0    0     0       0          0
veth1a2b3c:  333      1    0    0    0     0          0         0  444      2    0    0    0     0       0          0
br-12ab34cd:  555      1    0    0    0     0          0         0  666      2    0    0    0     0       0          0
  eth1: 1000 5 0 0 0 0 0 0 2000 6 0 0 0 0 0 0
`

func TestParseNetDevSkipsVirtual(t *testing.T) {
	n, err := ParseNetDev(strings.NewReader(netDev))
	if err != nil {
		t.Fatal(err)
	}
	if len(n.Ifaces) != 2 || n.Ifaces[0].Name != "eth0" || n.Ifaces[1].Name != "eth1" {
		t.Fatalf("ifaces: %+v", n.Ifaces)
	}
	if n.RxBytes != 912345678901+1000 || n.TxBytes != 934567890123+2000 {
		t.Fatalf("sum rx=%d tx=%d", n.RxBytes, n.TxBytes)
	}
}

func TestSkipIface(t *testing.T) {
	for _, s := range []string{"lo", "docker0", "veth9f", "br-abc", "virbr0", "wg0", "tun0", "cni0", "erspan0", "ip6_vti0", "ip_vti0", "ip6gre0", "gre0", "gretap0", "tunl0", "sit0"} {
		if !SkipIface(s) {
			t.Errorf("%s должен пропускаться", s)
		}
	}
	for _, s := range []string{"eth0", "ens3", "enp1s0", "venet0", "eno1", "bond0", "ens18"} {
		if SkipIface(s) {
			t.Errorf("%s не должен пропускаться", s)
		}
	}
}

func TestCPU(t *testing.T) {
	a, err := ParseCPUStat(strings.NewReader("cpu  100 0 50 800 50 0 0 0 0 0\ncpu0 1 1 1 1 1 1 1 1 1 1\n"))
	if err != nil {
		t.Fatal(err)
	}
	if a.Total != 1000 || a.Idle != 850 {
		t.Fatalf("%+v", a)
	}
	b, _ := ParseCPUStat(strings.NewReader("cpu  150 0 100 1600 50 0 0 0 0 0\n"))
	// dTotal = 1900-1000 = 900, dIdle = 1650-850 = 800 → занято 100/900
	p := CPUPercent(a, b)
	if p == nil || math.Abs(*p-11.111) > 0.01 {
		t.Fatalf("cpu = %v", p)
	}
	if CPUPercent(b, a) != nil {
		t.Fatal("откат счётчиков должен давать nil")
	}
}

func TestMeminfo(t *testing.T) {
	total, avail, err := ParseMeminfo(strings.NewReader("MemTotal:        2038076 kB\nMemFree:          100000 kB\nMemAvailable:    1487696 kB\n"))
	if err != nil || total != 2038076*1024 || avail != 1487696*1024 {
		t.Fatalf("%d %d %v", total, avail, err)
	}
	_, a2, err := ParseMeminfo(strings.NewReader("MemTotal: 1000 kB\nMemFree: 100 kB\nBuffers: 20 kB\nCached: 30 kB\n"))
	if err != nil || a2 != 150*1024 {
		t.Fatalf("fallback: %d %v", a2, err)
	}
}

func TestLoadUptime(t *testing.T) {
	a, b, c, err := ParseLoadavg(strings.NewReader("0.31 0.22 0.18 1/234 5678\n"))
	if err != nil || a != 0.31 || b != 0.22 || c != 0.18 {
		t.Fatal(a, b, c, err)
	}
	u, err := ParseUptime(strings.NewReader("864000.55 1700000.00\n"))
	if err != nil || u != 864000 {
		t.Fatal(u, err)
	}
}
