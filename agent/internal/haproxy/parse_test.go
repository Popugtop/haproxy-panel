package haproxy

import (
	"strings"
	"testing"

	"popug-bridges/agent/internal/proto"
)

// Образец show stat HAProxy 2.8 в стиле SNI-моста (колонки обрезаны до нужных плюс типичный хвост).
const statSample = `# pxname,svname,qcur,qmax,scur,smax,slim,stot,bin,bout,dreq,dresp,ereq,econ,eresp,wretr,wredis,status,weight,act,bck,chkfail,chkdown,lastchg,downtime,qlimit,pid,iid,sid,throttle,lbtot,tracked,type,rate,rate_lim,rate_max,check_status,check_code,check_duration,
fe_sni,FRONTEND,,,37,120,20000,5122,123456799,987654341,0,0,0,,,,,OPEN,,,,,,,,,1,2,0,,,,0,5,0,40,,,,,
be_de,de1,0,0,37,110,,5120,123456789,987654321,,0,,0,0,0,0,UP,1,1,0,0,0,86400,0,,1,3,1,,5120,,2,5,,40,L4OK,,3,
be_de,BACKEND,0,0,37,110,2000,5120,123456789,987654321,0,0,,0,0,0,0,UP,1,1,0,,0,86400,0,,1,3,0,,5120,,1,5,,40,,,,
be_se,se1,0,0,0,0,,2,10,20,,0,,1,0,0,0,DOWN,1,1,0,3,1,600,600,,1,4,1,,2,,2,0,,1,L4TOUT,,,
be_se,BACKEND,0,0,0,0,2000,2,10,20,0,0,,1,0,0,0,DOWN,0,0,0,,1,600,600,,1,4,0,,2,,1,0,,1,,,,
be_nocheck,s1,0,0,2,2,,9,5,6,,0,,0,0,0,0,no check,1,1,0,0,0,0,0,,1,5,1,,9,,2,0,,1,,,,
be_nocheck,BACKEND,0,0,2,2,200,9,5,6,0,0,,0,0,0,0,UP,1,1,0,,0,0,0,,1,5,0,,9,,1,0,,1,,,,
st_clients,BACKEND,0,0,0,0,200,0,0,0,0,0,,0,0,0,0,UP,0,0,0,,0,100,0,,1,6,0,,0,,1,0,,0,,,,
`

func TestParseStat(t *testing.T) {
	be, fe, err := ParseStat(strings.NewReader(statSample))
	if err != nil {
		t.Fatal(err)
	}
	if len(fe) != 1 || fe[0].Name != "fe_sni" || fe[0].Scur != 37 || fe[0].Bin != 123456799 {
		t.Fatalf("frontends: %+v", fe)
	}
	if len(be) != 3 { // st_clients отфильтрован
		t.Fatalf("backends: %+v", be)
	}
	de := be[0]
	if de.Name != "be_de" || de.Status != "UP" || de.Bin != 123456789 || de.Bout != 987654321 || de.Scur != 37 || de.Stot != 5120 {
		t.Fatalf("be_de: %+v", de)
	}
	if len(de.Servers) != 1 || de.Servers[0].Check == nil || *de.Servers[0].Check != "L4OK" || de.Servers[0].CheckMs == nil || *de.Servers[0].CheckMs != 3 {
		t.Fatalf("de servers: %+v", de.Servers)
	}
	se := be[1]
	if se.Status != "DOWN" || se.Servers[0].Status != "DOWN" || *se.Servers[0].Check != "L4TOUT" || se.Servers[0].CheckMs != nil {
		t.Fatalf("be_se: %+v", se)
	}
	if be[2].Servers[0].Status != "no check" || be[2].Servers[0].Check != nil {
		t.Fatalf("no check: %+v", be[2].Servers[0])
	}
}

func TestParseStatErrors(t *testing.T) {
	for _, in := range []string{"", "Permission denied\n", "# pxname,svname\nx,y\n"} {
		if _, _, err := ParseStat(strings.NewReader(in)); err == nil {
			t.Errorf("ожидалась ошибка для %q", in)
		}
	}
}

func TestParseInfo(t *testing.T) {
	in, err := ParseInfo(strings.NewReader("Name: HAProxy\nVersion: 2.8.5-1ppa1~jammy\nRelease_date: 2024/01/01\nUptime_sec: 86400\nNbthread: 2\n"))
	if err != nil || in.Version != "2.8.5-1ppa1~jammy" || in.UptimeSec != 86400 {
		t.Fatalf("%+v %v", in, err)
	}
	if _, err := ParseInfo(strings.NewReader("garbage")); err == nil {
		t.Fatal("ожидалась ошибка")
	}
}

const tableSample = `# table: st_clients, type: ipv6, size:204800, used:4
0x55d0a1b2c3d0: key=::ffff:198.51.100.7 use=0 exp=86399000 shard=0 conn_cnt=311 conn_cur=4 bytes_in_cnt=12345678 bytes_in_rate(60000)=3120000 bytes_out_cnt=765432109 bytes_out_rate(60000)=75000000
0x55d0a1b2c4e0: key=::ffff:203.0.113.9 use=0 exp=86100000 shard=0 conn_cnt=3 conn_cur=0 bytes_in_cnt=100 bytes_in_rate(60000)=0 bytes_out_cnt=900 bytes_out_rate(60000)=0
0x55d0a1b2c5f0: key=2001:db8::5 use=0 exp=80000000 shard=0 conn_cnt=7 conn_cur=1 bytes_in_cnt=5000000 bytes_in_rate(60000)=600 bytes_out_cnt=50000000 bytes_out_rate(60000)=6000
0x55d0a1b2c6a0: key=::ffff:192.0.2.1 use=0 exp=80000000 shard=0 conn_cnt=1 conn_cur=0 bytes_in_cnt=90000000000 bytes_in_rate(60000)=0 bytes_out_cnt=900000000000 bytes_out_rate(60000)=0
`

func TestParseTable(t *testing.T) {
	rows, used, err := ParseTable(strings.NewReader(tableSample))
	if err != nil {
		t.Fatal(err)
	}
	if used != 4 || len(rows) != 4 {
		t.Fatalf("used=%d rows=%d", used, len(rows))
	}
	r := rows[0]
	if r.IP != "198.51.100.7" || r.ConnCur != 4 || r.ConnCnt != 311 || r.BytesIn != 12345678 || r.BytesOut != 765432109 {
		t.Fatalf("row0: %+v", r)
	}
	if r.RateIn != 52000 || r.RateOut != 1250000 { // 3120000/60, 75000000/60
		t.Fatalf("rates: %v %v", r.RateIn, r.RateOut)
	}
	if rows[2].IP != "2001:db8::5" {
		t.Fatalf("v6: %q", rows[2].IP)
	}
}

func TestParseTableErrors(t *testing.T) {
	for _, in := range []string{"Unknown table 'x'\n", "", "Table x not found\n"} {
		if _, _, err := ParseTable(strings.NewReader(in)); err == nil {
			t.Errorf("ожидалась ошибка для %q", in)
		}
	}
	// пустая, но валидная таблица
	rows, used, err := ParseTable(strings.NewReader("# table: st_clients, type: ipv6, size:204800, used:0\n"))
	if err != nil || len(rows) != 0 || used != 0 {
		t.Fatalf("%v %d %v", rows, used, err)
	}
}

func TestSummarize(t *testing.T) {
	rows, used, _ := ParseTable(strings.NewReader(tableSample))
	c := Summarize(rows, used, 1)
	if c.Tracked != 4 || c.Active != 2 {
		t.Fatalf("%+v", c)
	}
	// 2001:db8::5 держит соединение, но качает ~110 байт/с (keep-alive): среди «реально качающих» его нет
	if c.Flowing != 1 {
		t.Fatalf("flowing: %+v", c)
	}
	// топ-1 по скорости (198.51.100.7) + топ-1 по объёму (192.0.2.1)
	if len(c.Top) != 2 || c.Top[0].IP != "198.51.100.7" || c.Top[1].IP != "192.0.2.1" {
		t.Fatalf("top: %+v", c.Top)
	}
}

func TestSummarizeFlowingGroupsIPv6Privacy(t *testing.T) {
	rows := []proto.ClientRow{
		{IP: "2001:db8:1:2::a", ConnCur: 1, RateOut: 5000},
		{IP: "2001:db8:1:2:ffff::b", ConnCur: 2, RateOut: 9000}, // то же устройство, другой privacy-адрес
		{IP: "2001:db8:1:3::a", ConnCur: 1, RateOut: 5000},      // другая сеть /64
		{IP: "198.51.100.7", ConnCur: 1, RateIn: 800, RateOut: 800},
		{IP: "198.51.100.8", ConnCur: 1, RateOut: 10},    // keep-alive, не качает
		{IP: "198.51.100.9", ConnCur: 0, RateOut: 99999}, // уже без соединений
	}
	c := Summarize(rows, 6, 3)
	if c.Active != 5 || c.Flowing != 3 {
		t.Fatalf("active=%d flowing=%d", c.Active, c.Flowing)
	}
}
