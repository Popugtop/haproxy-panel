package apply

import (
	"context"
	"fmt"
	"os/exec"
	"time"
)

// allowedCommands — единственные программы, которые агент вообще способен запустить в рамках применения конфига.
var allowedCommands = map[string]bool{"haproxy": true, "systemctl": true, "journalctl": true}

// ExecRunner запускает фиксированные команды с таймаутом.
type ExecRunner struct{}

func (ExecRunner) Run(ctx context.Context, name string, args ...string) ([]byte, error) {
	if !allowedCommands[name] {
		return nil, fmt.Errorf("команда %q не разрешена", name)
	}
	cctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	return exec.CommandContext(cctx, name, args...).CombinedOutput()
}
