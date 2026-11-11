// Package proto повторяет схемы protocol/src/index.ts (источник правды — TypeScript).
// Соответствие проверяется общими фикстурами protocol/fixtures в proto_test.go.
package proto

import "encoding/json"

const Version = 1

// Коды закрытия WebSocket.
const (
	CloseProtocolMismatch = 4000
	CloseUnauthorized     = 4001
	CloseKeyRevoked       = 4003
	CloseSuperseded       = 4004
	CloseBadFrame         = 4005
)

// Операции, которые агент умеет выполнять. Любая другая отклоняется.
const (
	OpPing        = "ping"
	OpGetConfig   = "get_config"
	OpApplyConfig = "apply_config"
	OpRunChecks   = "run_checks"
	OpApplyBans   = "apply_bans"
	OpGetClients  = "get_clients"
	OpUpdateAgent = "update_agent"
)

var SupportedOps = []string{OpPing, OpGetConfig, OpApplyConfig, OpRunChecks, OpApplyBans, OpGetClients, OpUpdateAgent}

type HAProxyInfo struct {
	Installed bool    `json:"installed"`
	Running   bool    `json:"running"`
	Version   *string `json:"version"`
}

type Hello struct {
	T            string      `json:"t"`
	Protocol     int         `json:"protocol"`
	AgentVersion string      `json:"agentVersion"`
	Hostname     string      `json:"hostname"`
	OS           string      `json:"os"`
	Arch         string      `json:"arch"`
	HAProxy      HAProxyInfo `json:"haproxy"`
	Ops          []string    `json:"ops"`
	Addrs        []string    `json:"addrs"`
	ConfigSha256 *string     `json:"configSha256"`
	UpdateReady  bool        `json:"updateReady"`
}

type ServerStat struct {
	Name    string   `json:"name"`
	Status  string   `json:"status"`
	Check   *string  `json:"check"`
	CheckMs *float64 `json:"checkMs"`
}

type BackendStat struct {
	Name    string       `json:"name"`
	Status  string       `json:"status"`
	Bin     int64        `json:"bin"`
	Bout    int64        `json:"bout"`
	Stot    int64        `json:"stot"`
	Scur    int64        `json:"scur"`
	Servers []ServerStat `json:"servers"`
}

type FrontendStat struct {
	Name string `json:"name"`
	Scur int64  `json:"scur"`
	Bin  int64  `json:"bin"`
	Bout int64  `json:"bout"`
	Stot int64  `json:"stot"`
}

type ClientRow struct {
	IP       string  `json:"ip"`
	ConnCur  int64   `json:"connCur"`
	ConnCnt  int64   `json:"connCnt"`
	BytesIn  int64   `json:"bytesIn"`
	BytesOut int64   `json:"bytesOut"`
	RateIn   float64 `json:"rateIn"`
	RateOut  float64 `json:"rateOut"`
}

type Iface struct {
	Name string `json:"name"`
	Rx   int64  `json:"rx"`
	Tx   int64  `json:"tx"`
}

type Net struct {
	RxBytes int64   `json:"rxBytes"`
	TxBytes int64   `json:"txBytes"`
	Ifaces  []Iface `json:"ifaces"`
}

type Sys struct {
	CPUPct    *float64 `json:"cpuPct"`
	Load1     float64  `json:"load1"`
	Load5     float64  `json:"load5"`
	Load15    float64  `json:"load15"`
	MemTotal  int64    `json:"memTotal"`
	MemAvail  int64    `json:"memAvail"`
	UptimeSec int64    `json:"uptimeSec"`
	Net       Net      `json:"net"`
}

type HAProxyMetrics struct {
	OK        bool           `json:"ok"`
	Error     *string        `json:"error"`
	Version   *string        `json:"version"`
	UptimeSec *int64         `json:"uptimeSec"`
	Backends  []BackendStat  `json:"backends"`
	Frontends []FrontendStat `json:"frontends"`
}

type Clients struct {
	Tracked int64 `json:"tracked"`
	// Active — IP с открытыми соединениями; открытое соединение не значит, что человек что-то качает.
	Active int64 `json:"active"`
	// Flowing — IP, через которые за последнюю минуту шёл заметный трафик (см. haproxy.FlowingMinBps).
	Flowing int64       `json:"flowing"`
	Top     []ClientRow `json:"top"`
}

type Metrics struct {
	T            string         `json:"t"`
	Ts           int64          `json:"ts"`
	Seq          int64          `json:"seq"`
	Sys          Sys            `json:"sys"`
	HAProxy      HAProxyMetrics `json:"haproxy"`
	Clients      *Clients       `json:"clients"`
	ClientsError *string        `json:"clientsError"`
}

type Result struct {
	T     string      `json:"t"`
	ID    string      `json:"id"`
	OK    bool        `json:"ok"`
	Error *string     `json:"error"`
	Data  interface{} `json:"data,omitempty"`
}

type ConfigData struct {
	Path    string `json:"path"`
	Content string `json:"content"`
	SHA256  string `json:"sha256"`
	// Maps — файлы карт (*.map), на которые ссылается конфиг через map(...). Нужны панели, чтобы импортировать SNI-маршруты,
	// записанные в карте. Агент отдаёт только файлы внутри каталога конфига.
	Maps []ConfigMap `json:"maps,omitempty"`
}

type ConfigMap struct {
	Path    string `json:"path"`
	Content string `json:"content"`
}

// Проверки «агент → выход».

type CheckResult struct {
	RouteID string   `json:"routeId"`
	ExitID  string   `json:"exitId"`
	OK      bool     `json:"ok"`
	Ms      *float64 `json:"ms"`
	Error   *string  `json:"error"`
}

type Checks struct {
	T       string        `json:"t"`
	Ts      int64         `json:"ts"`
	Results []CheckResult `json:"results"`
}

type CheckTarget struct {
	RouteID string `json:"routeId"`
	ExitID  string `json:"exitId"`
	Host    string `json:"host"`
	Port    int    `json:"port"`
	SNI     string `json:"sni"`
	Proxy   bool   `json:"proxy"`
}

type ChecksConfig struct {
	T           string        `json:"t"`
	IntervalSec int           `json:"intervalSec"`
	Targets     []CheckTarget `json:"targets"`
}

// apply_config.

type ApplyArgs struct {
	Version      int64  `json:"version"`
	Cfg          string `json:"cfg"`
	SniMap       string `json:"sniMap"`
	ValidateOnly bool   `json:"validateOnly"`
}

type ApplyResult struct {
	Version        int64   `json:"version"`
	Applied        bool    `json:"applied"`
	RolledBack     bool    `json:"rolledBack"`
	RollbackFailed bool    `json:"rollbackFailed"`
	Sha256         *string `json:"sha256"`
	Output         string  `json:"output"`
	DurationMs     float64 `json:"durationMs"`
}

// Баны.

type BanItem struct {
	IP     string `json:"ip"`
	TTLSec int64  `json:"ttlSec"`
}

type BansArgs struct {
	Full  bool      `json:"full"`
	Ban   []BanItem `json:"ban"`
	Unban []string  `json:"unban"`
}

type BansRejected struct {
	IP     string `json:"ip"`
	Reason string `json:"reason"`
}

type BansResult struct {
	Active   int            `json:"active"`
	Rejected []BansRejected `json:"rejected"`
}

// Обновление агента.

type UpdateArgs struct {
	Version string `json:"version"`
	Sha256  string `json:"sha256"`
}

type UpdateResult struct {
	From       string `json:"from"`
	To         string `json:"to"`
	Restarting bool   `json:"restarting"`
}

// Входящие от панели.

type Envelope struct {
	T string `json:"t"`
}

type Welcome struct {
	T                  string `json:"t"`
	Protocol           int    `json:"protocol"`
	ServerTime         int64  `json:"serverTime"`
	NodeID             string `json:"nodeId"`
	MetricsIntervalSec int    `json:"metricsIntervalSec"`
}

type Cmd struct {
	T    string          `json:"t"`
	ID   string          `json:"id"`
	Op   string          `json:"op"`
	Args json.RawMessage `json:"args,omitempty"`
}

// HTTP-регистрация.

type EnrollRequest struct {
	Token        string `json:"token"`
	Protocol     int    `json:"protocol"`
	AgentVersion string `json:"agentVersion"`
	Hostname     string `json:"hostname"`
}

type EnrollResponse struct {
	NodeID string `json:"nodeId"`
	Key    string `json:"key"`
}

func Str(s string) *string { return &s }
