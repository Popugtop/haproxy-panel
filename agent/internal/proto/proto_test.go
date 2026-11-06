package proto

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func fixture(t *testing.T, name string, v any) {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("..", "..", "..", "protocol", "fixtures", name))
	if err != nil {
		t.Fatal(err)
	}
	dec := json.NewDecoder(bytesReader(b))
	dec.DisallowUnknownFields() // поле, которого нет в Go-типах, — расхождение с протоколом
	if err := dec.Decode(v); err != nil {
		t.Fatalf("%s: %v", name, err)
	}
}

func TestFixtures(t *testing.T) {
	var h Hello
	fixture(t, "hello.json", &h)
	if h.Protocol != Version || h.HAProxy.Version == nil || *h.HAProxy.Version != "2.8.5" || len(h.Ops) != 7 || h.ConfigSha256 == nil {
		t.Fatalf("hello: %+v", h)
	}

	var m Metrics
	fixture(t, "metrics.json", &m)
	if m.Seq != 42 || len(m.HAProxy.Backends) != 2 || m.Clients == nil || m.Clients.Top[0].IP != "198.51.100.7" {
		t.Fatalf("metrics: %+v", m)
	}
	if m.HAProxy.Backends[1].Servers[0].CheckMs != nil {
		t.Fatal("checkMs должен быть null")
	}
	if m.Sys.Net.RxBytes != 912345678901 {
		t.Fatalf("rx: %d", m.Sys.Net.RxBytes)
	}

	var w Welcome
	fixture(t, "welcome.json", &w)
	if w.MetricsIntervalSec != 15 {
		t.Fatalf("welcome: %+v", w)
	}

	var c Cmd
	fixture(t, "cmd_get_config.json", &c)
	if c.Op != OpGetConfig || c.ID != "c-17" {
		t.Fatalf("cmd: %+v", c)
	}

	var ap Cmd
	fixture(t, "cmd_apply_config.json", &ap)
	var args ApplyArgs
	if err := json.Unmarshal(ap.Args, &args); err != nil || ap.Op != OpApplyConfig || args.Version != 7 || args.SniMap == "" {
		t.Fatalf("apply cmd: %+v %v", ap, err)
	}
	var bn Cmd
	fixture(t, "cmd_apply_bans.json", &bn)
	var bargs BansArgs
	if err := json.Unmarshal(bn.Args, &bargs); err != nil || bn.Op != OpApplyBans || bargs.Full || len(bargs.Ban) != 1 || bargs.Ban[0].TTLSec != 3600 || bargs.Unban[0] != "198.51.100.9" {
		t.Fatalf("apply_bans: %+v %v", bn, err)
	}
	var gc Cmd
	fixture(t, "cmd_get_clients.json", &gc)
	var ua Cmd
	fixture(t, "cmd_update_agent.json", &ua)
	var uargs UpdateArgs
	if err := json.Unmarshal(ua.Args, &uargs); err != nil || gc.Op != OpGetClients || ua.Op != OpUpdateAgent || uargs.Version != "0.3.0" || len(uargs.Sha256) != 64 {
		t.Fatalf("get_clients/update_agent: %+v %+v %v", gc, ua, err)
	}
	var rc Cmd
	fixture(t, "cmd_run_checks.json", &rc)
	if rc.Op != OpRunChecks {
		t.Fatalf("run_checks: %+v", rc)
	}
	var ch Checks
	fixture(t, "checks.json", &ch)
	if len(ch.Results) != 2 || !ch.Results[0].OK || ch.Results[1].OK || ch.Results[1].Error == nil || ch.Results[1].Ms != nil {
		t.Fatalf("checks: %+v", ch)
	}
	var cc ChecksConfig
	fixture(t, "checks_config.json", &cc)
	if cc.IntervalSec != 30 || len(cc.Targets) != 1 || !cc.Targets[0].Proxy || cc.Targets[0].Port != 443 {
		t.Fatalf("checks_config: %+v", cc)
	}
	var ar struct {
		T     string      `json:"t"`
		ID    string      `json:"id"`
		OK    bool        `json:"ok"`
		Error *string     `json:"error"`
		Data  ApplyResult `json:"data"`
	}
	fixture(t, "result_apply_config.json", &ar)
	if ar.OK || !ar.Data.RolledBack || ar.Data.Applied || ar.Data.Version != 7 {
		t.Fatalf("apply result: %+v", ar)
	}

	var e EnrollResponse
	fixture(t, "enroll_response.json", &e)
	if e.Key == "" {
		t.Fatal("enroll")
	}

	var r struct {
		T     string     `json:"t"`
		ID    string     `json:"id"`
		OK    bool       `json:"ok"`
		Error *string    `json:"error"`
		Data  ConfigData `json:"data"`
	}
	fixture(t, "result_get_config.json", &r)
	if !r.OK || r.Data.Path != "/etc/haproxy/haproxy.cfg" {
		t.Fatalf("result: %+v", r)
	}
	if len(r.Data.Maps) != 1 || r.Data.Maps[0].Path != "/etc/haproxy/sni.map" || r.Data.Maps[0].Content != "de.example.com be_de\n" {
		t.Fatalf("maps: %+v", r.Data.Maps)
	}
}
