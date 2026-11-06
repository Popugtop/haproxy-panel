// popug-agent — агент RU-моста: подключается к панели, шлёт метрики, выполняет фиксированный набор операций.
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"syscall"
	"time"

	"popug-bridges/agent/internal/client"
	"popug-bridges/agent/internal/config"
	"popug-bridges/agent/internal/proto"
)

// version задаётся при сборке: -ldflags "-X main.version=1.2.3".
var version = "dev"

const usage = `popug-agent %s

Использование:
  popug-agent enroll --panel URL --token TOKEN   зарегистрировать ноду (один раз)
  popug-agent run                                 подключиться к панели (запускает systemd)
  popug-agent check                               снять метрики один раз и вывести JSON
  popug-agent version

Общий флаг: --config PATH (по умолчанию %s)
`

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintf(os.Stderr, usage, version, config.DefaultConfigPath)
		os.Exit(2)
	}
	log := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelInfo}))
	var err error
	switch os.Args[1] {
	case "run":
		err = cmdRun(log, os.Args[2:])
	case "enroll":
		err = cmdEnroll(os.Args[2:])
	case "check":
		err = cmdCheck(log, os.Args[2:])
	case "version", "--version", "-v":
		fmt.Println(version)
	case "help", "--help", "-h":
		fmt.Printf(usage, version, config.DefaultConfigPath)
	default:
		fmt.Fprintf(os.Stderr, usage, version, config.DefaultConfigPath)
		os.Exit(2)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "ошибка:", err)
		os.Exit(1)
	}
}

func cmdRun(log *slog.Logger, args []string) error {
	fs := flag.NewFlagSet("run", flag.ExitOnError)
	path := fs.String("config", config.DefaultConfigPath, "путь к config.json")
	fs.Parse(args)

	cfg, err := config.Load(*path)
	if err != nil {
		return err
	}
	key, err := config.ReadKey(cfg.KeyFile)
	if err != nil {
		return err
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	log.Info("popug-agent запущен", "version", version, "protocol", proto.Version, "panel", cfg.PanelURL)
	client.New(cfg, key, version, log).Run(ctx)
	log.Info("остановлен")
	return nil
}

func cmdEnroll(args []string) error {
	fs := flag.NewFlagSet("enroll", flag.ExitOnError)
	path := fs.String("config", config.DefaultConfigPath, "путь к config.json")
	panel := fs.String("panel", "", "адрес панели, https://…")
	token := fs.String("token", "", "одноразовый токен из панели")
	fs.Parse(args)

	cfg := config.Default()
	if existing, err := config.Load(*path); err == nil {
		cfg = existing // сохраняем пользовательские настройки при перерегистрации
	}
	if *panel != "" {
		cfg.PanelURL = *panel
	}
	if *token == "" {
		*token = os.Getenv("POPUG_TOKEN")
	}
	if *token == "" {
		return fmt.Errorf("укажите --token (или переменную POPUG_TOKEN)")
	}
	if err := cfg.Validate(); err != nil {
		return err
	}
	host, _ := os.Hostname()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	res, err := client.Enroll(ctx, cfg.PanelURL, *token, version, host)
	if err != nil {
		return err
	}
	cfg.NodeID = res.NodeID
	if err := config.SaveKey(cfg.KeyFile, res.Key); err != nil {
		return fmt.Errorf("не удалось сохранить ключ: %w", err)
	}
	if err := cfg.Save(*path); err != nil {
		return fmt.Errorf("не удалось сохранить конфиг: %w", err)
	}
	fmt.Printf("нода зарегистрирована: %s\nключ: %s (права 600)\nконфиг: %s\n", res.NodeID, cfg.KeyFile, *path)
	return nil
}

// cmdCheck снимает метрики локально, без панели: удобно проверить доступ к сокету и /proc.
func cmdCheck(log *slog.Logger, args []string) error {
	fs := flag.NewFlagSet("check", flag.ExitOnError)
	path := fs.String("config", config.DefaultConfigPath, "путь к config.json")
	fs.Parse(args)
	cfg, err := config.Load(*path)
	if err != nil {
		cfg = config.Default()
		cfg.PanelURL = "https://localhost"
	}
	c := client.New(cfg, "", version, log)
	c.Collect() // первый замер прогревает счётчик CPU
	time.Sleep(time.Second)
	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", "  ")
	return enc.Encode(c.Collect())
}
