// popug-release — инструмент владельца релизов: генерирует ключ подписи и подписывает бинарники агента.
// Приватный ключ хранится у вас (не в панели и не в репозитории): без него обновить агентов по кнопке нельзя.
package main

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"flag"
	"fmt"
	"os"
	"strings"

	"popug-bridges/agent/internal/update"
)

func die(format string, a ...any) {
	fmt.Fprintf(os.Stderr, "ошибка: "+format+"\n", a...)
	os.Exit(1)
}

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, "использование:\n  popug-release keygen -key release.key -pub release.pub\n  popug-release sign -key release.key -version 0.3.0 -arch amd64 -o файл.sig файл")
		os.Exit(2)
	}
	switch os.Args[1] {
	case "keygen":
		fs := flag.NewFlagSet("keygen", flag.ExitOnError)
		keyPath := fs.String("key", "release.key", "куда записать приватный ключ")
		pubPath := fs.String("pub", "release.pub", "куда записать публичный ключ")
		fs.Parse(os.Args[2:])
		if _, err := os.Stat(*keyPath); err == nil {
			die("%s уже существует: не перезаписываю", *keyPath)
		}
		pub, priv, err := ed25519.GenerateKey(rand.Reader)
		if err != nil {
			die("%v", err)
		}
		if err := os.WriteFile(*keyPath, []byte(base64.StdEncoding.EncodeToString(priv)+"\n"), 0o600); err != nil {
			die("%v", err)
		}
		if err := os.WriteFile(*pubPath, []byte(base64.StdEncoding.EncodeToString(pub)+"\n"), 0o644); err != nil {
			die("%v", err)
		}
		fmt.Printf("ключ создан: %s (секретный, храните отдельно от панели), %s (публичный, его получают агенты при установке)\n", *keyPath, *pubPath)
	case "sign":
		fs := flag.NewFlagSet("sign", flag.ExitOnError)
		keyPath := fs.String("key", "release.key", "приватный ключ")
		version := fs.String("version", "", "версия бинарника")
		arch := fs.String("arch", "", "amd64 или arm64")
		out := fs.String("o", "", "куда записать подпись")
		fs.Parse(os.Args[2:])
		if fs.NArg() != 1 || *version == "" || *arch == "" || *out == "" {
			die("нужны -version, -arch, -o и путь к бинарнику")
		}
		raw, err := os.ReadFile(*keyPath)
		if err != nil {
			die("%v", err)
		}
		priv, err := base64.StdEncoding.DecodeString(strings.TrimSpace(string(raw)))
		if err != nil || len(priv) != ed25519.PrivateKeySize {
			die("%s: не приватный ключ ed25519", *keyPath)
		}
		bin, err := os.ReadFile(fs.Arg(0))
		if err != nil {
			die("%v", err)
		}
		sum := sha256.Sum256(bin)
		sig := ed25519.Sign(ed25519.PrivateKey(priv), update.SignedMessage(*version, *arch, hex.EncodeToString(sum[:])))
		if err := os.WriteFile(*out, []byte(base64.StdEncoding.EncodeToString(sig)+"\n"), 0o644); err != nil {
			die("%v", err)
		}
		fmt.Printf("подписано: %s (%s, %s, sha256 %s…)\n", fs.Arg(0), *version, *arch, hex.EncodeToString(sum[:])[:12])
	default:
		die("неизвестная команда %q", os.Args[1])
	}
}
