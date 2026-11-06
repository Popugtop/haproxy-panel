// Package sysinfo читает сеть, CPU, RAM и load из /proc.
package sysinfo

import (
	"bufio"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"

	"popug-bridges/agent/internal/proto"
)

// Виртуальные интерфейсы, которые не считаем трафиком моста.
var skipPrefixes = []string{
	"lo", "docker", "veth", "br-", "virbr", "cni", "flannel", "cali", "kube",
	"tun", "tap", "dummy", "ifb", "vnet", "lxc", "wg", "tailscale", "zt", "sit", "ip6tnl", "gre", "bond0.",
	// служебные туннельные устройства ядра, которые есть на любой машине с модулями ip_gre/ip_vti
	"erspan", "ip_vti", "ip6_vti", "ip6gre", "gretap", "tunl", "teql", "nlmon",
}

func SkipIface(name string) bool {
	if name == "lo" {
		return true
	}
	for _, p := range skipPrefixes {
		if p != "lo" && strings.HasPrefix(name, p) {
			return true
		}
	}
	return false
}

// ParseNetDev разбирает /proc/net/dev. Возвращает сумму и список физических интерфейсов.
func ParseNetDev(r io.Reader) (proto.Net, error) {
	out := proto.Net{Ifaces: []proto.Iface{}}
	sc := bufio.NewScanner(r)
	for sc.Scan() {
		line := sc.Text()
		i := strings.IndexByte(line, ':')
		if i < 0 {
			continue // две строки заголовка
		}
		name := strings.TrimSpace(line[:i])
		if SkipIface(name) {
			continue
		}
		f := strings.Fields(line[i+1:])
		if len(f) < 9 {
			continue
		}
		rx, err1 := strconv.ParseInt(f[0], 10, 64)
		tx, err2 := strconv.ParseInt(f[8], 10, 64)
		if err1 != nil || err2 != nil {
			continue
		}
		out.Ifaces = append(out.Ifaces, proto.Iface{Name: name, Rx: rx, Tx: tx})
		out.RxBytes += rx
		out.TxBytes += tx
	}
	sort.Slice(out.Ifaces, func(i, j int) bool { return out.Ifaces[i].Name < out.Ifaces[j].Name })
	return out, sc.Err()
}

// CPUTimes — счётчики первой строки /proc/stat в «тиках».
type CPUTimes struct{ Idle, Total uint64 }

func ParseCPUStat(r io.Reader) (CPUTimes, error) {
	sc := bufio.NewScanner(r)
	for sc.Scan() {
		f := strings.Fields(sc.Text())
		if len(f) < 5 || f[0] != "cpu" {
			continue
		}
		var v []uint64
		for _, s := range f[1:] {
			n, err := strconv.ParseUint(s, 10, 64)
			if err != nil {
				return CPUTimes{}, err
			}
			v = append(v, n)
		}
		// user nice system idle iowait irq softirq steal [guest guest_nice — уже внутри user/nice]
		n := len(v)
		if n > 8 {
			n = 8
		}
		var total uint64
		for _, x := range v[:n] {
			total += x
		}
		idle := v[3]
		if len(v) > 4 {
			idle += v[4]
		}
		return CPUTimes{Idle: idle, Total: total}, nil
	}
	return CPUTimes{}, fmt.Errorf("строка cpu не найдена в /proc/stat")
}

// CPUPercent — загрузка за интервал между двумя замерами, nil если данных недостаточно.
func CPUPercent(prev, cur CPUTimes) *float64 {
	if cur.Total <= prev.Total || cur.Idle < prev.Idle {
		return nil
	}
	dt := float64(cur.Total - prev.Total)
	di := float64(cur.Idle - prev.Idle)
	p := (1 - di/dt) * 100
	if p < 0 {
		p = 0
	}
	if p > 100 {
		p = 100
	}
	return &p
}

// ParseMeminfo возвращает MemTotal и MemAvailable в байтах.
func ParseMeminfo(r io.Reader) (total, avail int64, err error) {
	var gotT, gotA, free, buffers, cached bool
	var vfree, vbuf, vcache int64
	sc := bufio.NewScanner(r)
	for sc.Scan() {
		f := strings.Fields(sc.Text())
		if len(f) < 2 {
			continue
		}
		n, perr := strconv.ParseInt(f[1], 10, 64)
		if perr != nil {
			continue
		}
		n *= 1024 // значения в kB
		switch f[0] {
		case "MemTotal:":
			total, gotT = n, true
		case "MemAvailable:":
			avail, gotA = n, true
		case "MemFree:":
			vfree, free = n, true
		case "Buffers:":
			vbuf, buffers = n, true
		case "Cached:":
			vcache, cached = n, true
		}
	}
	if !gotT {
		return 0, 0, fmt.Errorf("MemTotal не найден")
	}
	if !gotA { // ядра старше 3.14
		if !(free && buffers && cached) {
			return 0, 0, fmt.Errorf("MemAvailable не найден")
		}
		avail = vfree + vbuf + vcache
	}
	return total, avail, sc.Err()
}

func ParseLoadavg(r io.Reader) (l1, l5, l15 float64, err error) {
	b, err := io.ReadAll(io.LimitReader(r, 4096))
	if err != nil {
		return
	}
	f := strings.Fields(string(b))
	if len(f) < 3 {
		return 0, 0, 0, fmt.Errorf("неожиданный формат /proc/loadavg")
	}
	if l1, err = strconv.ParseFloat(f[0], 64); err != nil {
		return
	}
	if l5, err = strconv.ParseFloat(f[1], 64); err != nil {
		return
	}
	l15, err = strconv.ParseFloat(f[2], 64)
	return
}

func ParseUptime(r io.Reader) (int64, error) {
	b, err := io.ReadAll(io.LimitReader(r, 4096))
	if err != nil {
		return 0, err
	}
	f := strings.Fields(string(b))
	if len(f) < 1 {
		return 0, fmt.Errorf("неожиданный формат /proc/uptime")
	}
	v, err := strconv.ParseFloat(f[0], 64)
	return int64(v), err
}

// Collector хранит предыдущий замер CPU.
type Collector struct {
	Root    string // корень procfs; "/proc" по умолчанию, в тестах — каталог с образцами
	prevCPU *CPUTimes
}

func NewCollector() *Collector { return &Collector{Root: "/proc"} }

func (c *Collector) open(name string) (*os.File, error) { return os.Open(filepath.Join(c.Root, name)) }

func (c *Collector) Collect() (proto.Sys, error) {
	var s proto.Sys
	var err error

	f, err := c.open("net/dev")
	if err != nil {
		return s, err
	}
	s.Net, err = ParseNetDev(f)
	f.Close()
	if err != nil {
		return s, err
	}

	if f, err = c.open("stat"); err == nil {
		cur, perr := ParseCPUStat(f)
		f.Close()
		if perr == nil {
			if c.prevCPU != nil {
				s.CPUPct = CPUPercent(*c.prevCPU, cur)
			}
			c.prevCPU = &cur
		}
	}
	if f, err = c.open("meminfo"); err == nil {
		s.MemTotal, s.MemAvail, _ = ParseMeminfo(f)
		f.Close()
	}
	if f, err = c.open("loadavg"); err == nil {
		s.Load1, s.Load5, s.Load15, _ = ParseLoadavg(f)
		f.Close()
	}
	if f, err = c.open("uptime"); err == nil {
		s.UptimeSec, _ = ParseUptime(f)
		f.Close()
	}
	return s, nil
}
