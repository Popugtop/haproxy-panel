// Package haproxy читает stats-сокет HAProxy: show stat / show table / show info.
package haproxy

import (
	"bufio"
	"encoding/csv"
	"fmt"
	"io"
	"net/netip"
	"sort"
	"strconv"
	"strings"

	"popug-bridges/agent/internal/proto"
)

// internalBackendPrefix — служебные бэкенды-хранилища stick-table (st_clients, st_bwlim…), не маршруты.
const internalBackendPrefix = "st_"

// ParseStat разбирает вывод `show stat` (CSV, первая строка — заголовок с «# »).
func ParseStat(r io.Reader) ([]proto.BackendStat, []proto.FrontendStat, error) {
	br := bufio.NewReader(io.LimitReader(r, 32<<20))
	cr := csv.NewReader(br)
	cr.FieldsPerRecord = -1
	cr.LazyQuotes = true

	header, err := cr.Read()
	if err != nil {
		if err == io.EOF {
			return nil, nil, fmt.Errorf("пустой ответ show stat")
		}
		return nil, nil, err
	}
	if len(header) == 0 || !strings.HasPrefix(header[0], "# pxname") {
		return nil, nil, fmt.Errorf("неожиданный заголовок show stat: %.60q", strings.Join(header, ","))
	}
	header[0] = strings.TrimPrefix(header[0], "# ")
	col := make(map[string]int, len(header))
	for i, h := range header {
		col[h] = i
	}
	for _, need := range []string{"pxname", "svname", "scur", "stot", "bin", "bout", "status", "type"} {
		if _, ok := col[need]; !ok {
			return nil, nil, fmt.Errorf("в show stat нет колонки %q", need)
		}
	}
	get := func(rec []string, name string) string {
		if i, ok := col[name]; ok && i < len(rec) {
			return rec[i]
		}
		return ""
	}
	num := func(rec []string, name string) int64 {
		v, _ := strconv.ParseInt(get(rec, name), 10, 64)
		if v < 0 {
			return 0
		}
		return v
	}

	backends := map[string]*proto.BackendStat{}
	var order []string
	var frontends []proto.FrontendStat
	var servers []struct {
		px string
		s  proto.ServerStat
	}

	for {
		rec, err := cr.Read()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, nil, err
		}
		if len(rec) < 2 || strings.HasPrefix(rec[0], "#") {
			continue
		}
		px, sv := get(rec, "pxname"), get(rec, "svname")
		switch get(rec, "type") {
		case "0": // frontend
			frontends = append(frontends, proto.FrontendStat{
				Name: px, Scur: num(rec, "scur"), Bin: num(rec, "bin"), Bout: num(rec, "bout"), Stot: num(rec, "stot"),
			})
		case "1": // backend
			if strings.HasPrefix(px, internalBackendPrefix) {
				continue
			}
			backends[px] = &proto.BackendStat{
				Name: px, Status: get(rec, "status"),
				Bin: num(rec, "bin"), Bout: num(rec, "bout"), Stot: num(rec, "stot"), Scur: num(rec, "scur"),
				Servers: []proto.ServerStat{},
			}
			order = append(order, px)
		case "2": // server
			s := proto.ServerStat{Name: sv, Status: get(rec, "status")}
			if cs := get(rec, "check_status"); cs != "" {
				s.Check = &cs
			}
			if d := get(rec, "check_duration"); d != "" {
				if v, err := strconv.ParseFloat(d, 64); err == nil && v >= 0 {
					s.CheckMs = &v
				}
			}
			servers = append(servers, struct {
				px string
				s  proto.ServerStat
			}{px, s})
		}
	}
	for _, sv := range servers {
		if b, ok := backends[sv.px]; ok {
			b.Servers = append(b.Servers, sv.s)
		}
	}
	out := make([]proto.BackendStat, 0, len(order))
	for _, name := range order {
		out = append(out, *backends[name])
	}
	if frontends == nil {
		frontends = []proto.FrontendStat{}
	}
	return out, frontends, nil
}

// Info — нужные поля `show info`.
type Info struct {
	Version   string
	UptimeSec int64
}

func ParseInfo(r io.Reader) (Info, error) {
	var in Info
	sc := bufio.NewScanner(io.LimitReader(r, 1<<20))
	for sc.Scan() {
		k, v, ok := strings.Cut(sc.Text(), ":")
		if !ok {
			continue
		}
		v = strings.TrimSpace(v)
		switch strings.TrimSpace(k) {
		case "Version":
			in.Version = v
		case "Uptime_sec":
			in.UptimeSec, _ = strconv.ParseInt(v, 10, 64)
		}
	}
	if in.Version == "" {
		return in, fmt.Errorf("в show info нет Version")
	}
	return in, sc.Err()
}

// ParseTable разбирает `show table <name>`.
//
//	# table: st_clients, type: ipv6, size:204800, used:3
//	0x55d0: key=::ffff:1.2.3.4 use=0 exp=86399000 shard=0 conn_cur=1 conn_cnt=3 bytes_in_cnt=1234 bytes_in_rate(60000)=12 bytes_out_cnt=5678 bytes_out_rate(60000)=34
//
// Скорости в таблице — байты за период окна; здесь пересчитываются в байт/с.
func ParseTable(r io.Reader) (rows []proto.ClientRow, used int64, err error) {
	sc := bufio.NewScanner(io.LimitReader(r, 64<<20))
	sc.Buffer(make([]byte, 0, 64*1024), 1<<20)
	headerSeen := false
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		switch {
		case line == "":
			continue
		case strings.HasPrefix(line, "# table:"):
			headerSeen = true
			for _, p := range strings.Split(line, ",") {
				if k, v, ok := strings.Cut(strings.TrimSpace(p), ":"); ok && strings.TrimSpace(k) == "used" {
					used, _ = strconv.ParseInt(strings.TrimSpace(v), 10, 64)
				}
			}
			continue
		case strings.HasPrefix(line, "Unknown table"), strings.Contains(line, "No such table"), strings.HasPrefix(line, "Table"):
			return nil, 0, fmt.Errorf("%s", line)
		case !strings.HasPrefix(line, "0x"):
			continue
		}
		row := proto.ClientRow{}
		has := false
		for _, tok := range strings.Fields(line)[1:] {
			k, v, ok := strings.Cut(tok, "=")
			if !ok {
				continue
			}
			period := 1.0
			if i := strings.IndexByte(k, '('); i >= 0 {
				if ms, perr := strconv.ParseFloat(strings.TrimSuffix(k[i+1:], ")"), 64); perr == nil && ms > 0 {
					period = ms / 1000
				}
				k = k[:i]
			}
			switch k {
			case "key":
				row.IP, has = normalizeIP(v), true
			case "conn_cur":
				row.ConnCur, _ = strconv.ParseInt(v, 10, 64)
			case "conn_cnt":
				row.ConnCnt, _ = strconv.ParseInt(v, 10, 64)
			case "bytes_in_cnt":
				row.BytesIn, _ = strconv.ParseInt(v, 10, 64)
			case "bytes_out_cnt":
				row.BytesOut, _ = strconv.ParseInt(v, 10, 64)
			case "bytes_in_rate":
				f, _ := strconv.ParseFloat(v, 64)
				row.RateIn = f / period
			case "bytes_out_rate":
				f, _ := strconv.ParseFloat(v, 64)
				row.RateOut = f / period
			}
		}
		if has && row.IP != "" {
			rows = append(rows, row)
		}
	}
	if err := sc.Err(); err != nil {
		return nil, 0, err
	}
	if !headerSeen && len(rows) == 0 {
		return nil, 0, fmt.Errorf("пустой ответ show table")
	}
	if used == 0 {
		used = int64(len(rows))
	}
	return rows, used, nil
}

func normalizeIP(s string) string {
	if a, err := netip.ParseAddr(s); err == nil {
		return a.Unmap().String()
	}
	return s
}

// Summarize считает активные IP и выбирает топ: объединение top-N по скорости и по объёму.
func Summarize(rows []proto.ClientRow, used int64, topN int) proto.Clients {
	c := proto.Clients{Tracked: used, Top: []proto.ClientRow{}}
	for _, r := range rows {
		if r.ConnCur > 0 {
			c.Active++
		}
	}
	pick := func(less func(a, b proto.ClientRow) bool) []proto.ClientRow {
		cp := append([]proto.ClientRow(nil), rows...)
		sort.Slice(cp, func(i, j int) bool { return less(cp[i], cp[j]) })
		if len(cp) > topN {
			cp = cp[:topN]
		}
		return cp
	}
	byRate := pick(func(a, b proto.ClientRow) bool { return a.RateIn+a.RateOut > b.RateIn+b.RateOut })
	byTotal := pick(func(a, b proto.ClientRow) bool { return a.BytesIn+a.BytesOut > b.BytesIn+b.BytesOut })
	seen := map[string]bool{}
	for _, list := range [][]proto.ClientRow{byRate, byTotal} {
		for _, r := range list {
			if !seen[r.IP] {
				seen[r.IP] = true
				c.Top = append(c.Top, r)
			}
		}
	}
	return c
}
