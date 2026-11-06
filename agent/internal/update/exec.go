package update

import (
	"context"
	"os/exec"
	"strings"
	"time"
)

func execOutput(ctx context.Context, path string, args ...string) (string, error) {
	cctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	out, err := exec.CommandContext(cctx, path, args...).Output()
	return strings.TrimSpace(string(out)), err
}

// ExecRunner запускает только systemctl restart popug-agent и ничего другого.
type ExecRunner struct{}

func (ExecRunner) Run(ctx context.Context, name string, args ...string) ([]byte, error) {
	if name != "systemctl" || len(args) != 2 || args[0] != "restart" || args[1] != "popug-agent" {
		return nil, context.Canceled
	}
	return exec.CommandContext(ctx, name, args...).CombinedOutput()
}
