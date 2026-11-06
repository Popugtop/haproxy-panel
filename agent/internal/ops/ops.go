// Package ops — закрытый набор операций, которые агент выполняет по команде панели.
//
// Принцип безопасности: операция выбирается по имени из фиксированной таблицы, пути и параметры
// берутся из локального конфига, а не из команды. Произвольных команд, шеллов и путей здесь нет.
package ops

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"

	"popug-bridges/agent/internal/apply"
	"popug-bridges/agent/internal/bans"
	"popug-bridges/agent/internal/checks"
	"popug-bridges/agent/internal/haproxy"
	"popug-bridges/agent/internal/proto"
	"popug-bridges/agent/internal/update"
)

type Dispatcher struct {
	HAProxyConfig string
	Applier       *apply.Applier
	Checks        *checks.Runner
	Bans          *bans.Manager
	Updater       *update.Updater
	// Clients отдаёт живую таблицу клиентов; задаётся клиентом агента.
	Clients  func(ctx context.Context) (any, error)
	handlers map[string]func(ctx context.Context, cmd proto.Cmd) (any, error)
}

func New(haproxyConfig string) *Dispatcher {
	d := &Dispatcher{HAProxyConfig: haproxyConfig}
	d.handlers = map[string]func(context.Context, proto.Cmd) (any, error){
		proto.OpPing:        d.ping,
		proto.OpGetConfig:   d.getConfig,
		proto.OpApplyConfig: d.applyConfig,
		proto.OpRunChecks:   d.runChecks,
		proto.OpApplyBans:   d.applyBans,
		proto.OpGetClients:  d.getClients,
		proto.OpUpdateAgent: d.updateAgent,
	}
	return d
}

// Handle всегда возвращает Result; неизвестная операция — ok=false, unsupported_op.
func (d *Dispatcher) Handle(ctx context.Context, cmd proto.Cmd) proto.Result {
	res := proto.Result{T: "result", ID: cmd.ID}
	h, ok := d.handlers[cmd.Op]
	if !ok {
		res.Error = proto.Str("unsupported_op: " + truncate(cmd.Op, 64))
		return res
	}
	data, err := h(ctx, cmd)
	res.Data = data // при ошибке данные тоже нужны: вывод HAProxy и признак отката
	if err != nil {
		res.Error = proto.Str(err.Error())
		return res
	}
	res.OK = true
	return res
}

func (d *Dispatcher) ping(context.Context, proto.Cmd) (any, error) {
	return map[string]bool{"pong": true}, nil
}

func (d *Dispatcher) getConfig(context.Context, proto.Cmd) (any, error) {
	b, err := haproxy.ReadConfig(d.HAProxyConfig)
	if err != nil {
		return nil, fmt.Errorf("не удалось прочитать %s: %w", d.HAProxyConfig, err)
	}
	sum := sha256.Sum256(b)
	return proto.ConfigData{Path: d.HAProxyConfig, Content: string(b), SHA256: hex.EncodeToString(sum[:])}, nil
}

func truncate(s string, n int) string {
	if len(s) > n {
		return s[:n]
	}
	return s
}

func (d *Dispatcher) applyConfig(ctx context.Context, cmd proto.Cmd) (any, error) {
	if d.Applier == nil {
		return nil, errors.New("применение конфига не настроено на агенте")
	}
	var args proto.ApplyArgs
	if err := json.Unmarshal(cmd.Args, &args); err != nil {
		return nil, fmt.Errorf("некорректные аргументы apply_config: %w", err)
	}
	res, err := d.Applier.Apply(ctx, args)
	return res, err
}

func (d *Dispatcher) runChecks(ctx context.Context, _ proto.Cmd) (any, error) {
	if d.Checks == nil {
		return nil, errors.New("проверки не настроены на агенте")
	}
	return map[string]any{"results": d.Checks.RunOnce(ctx)}, nil
}

func (d *Dispatcher) applyBans(ctx context.Context, cmd proto.Cmd) (any, error) {
	if d.Bans == nil {
		return nil, errors.New("баны не настроены на агенте")
	}
	var args proto.BansArgs
	if err := json.Unmarshal(cmd.Args, &args); err != nil {
		return nil, fmt.Errorf("некорректные аргументы apply_bans: %w", err)
	}
	return d.Bans.Apply(ctx, args)
}

func (d *Dispatcher) getClients(ctx context.Context, _ proto.Cmd) (any, error) {
	if d.Clients == nil {
		return nil, errors.New("таблица клиентов недоступна")
	}
	return d.Clients(ctx)
}

func (d *Dispatcher) updateAgent(ctx context.Context, cmd proto.Cmd) (any, error) {
	if d.Updater == nil {
		return nil, errors.New("обновление не настроено на агенте")
	}
	var args proto.UpdateArgs
	if err := json.Unmarshal(cmd.Args, &args); err != nil {
		return nil, fmt.Errorf("некорректные аргументы update_agent: %w", err)
	}
	return d.Updater.Update(ctx, args)
}
