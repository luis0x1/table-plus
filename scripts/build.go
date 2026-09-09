//go:build ignore

// Command build creates a QueryNest desktop or portable binary. Set
// QUERYNEST_PORTABLE=true to select portable storage beside the application.
package main

import (
	"fmt"
	"os"
	"os/exec"
	"runtime"
	"strings"
)

func main() {
	portable, err := parseBoolEnv("QUERYNEST_PORTABLE")
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(2)
	}
	mode := "desktop"
	if portable {
		mode = "portable"
	}
	buildArgs, err := configureLinuxWebKit(os.Args[1:])
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(2)
	}
	args := []string{"build", "-ldflags", "-X main.appBuildMode=" + mode}
	args = append(args, buildArgs...)
	command := exec.Command("wails", args...)
	command.Stdin, command.Stdout, command.Stderr = os.Stdin, os.Stdout, os.Stderr
	command.Env = os.Environ()
	if err := command.Run(); err != nil {
		if exitError, ok := err.(*exec.ExitError); ok {
			os.Exit(exitError.ExitCode())
		}
		fmt.Fprintf(os.Stderr, "run Wails build: %v\n", err)
		os.Exit(1)
	}
}

func configureLinuxWebKit(args []string) ([]string, error) {
	if runtime.GOOS != "linux" || !targetsLinux(args) {
		return args, nil
	}
	if exec.Command("pkg-config", "--exists", "webkit2gtk-4.0").Run() == nil {
		return args, nil
	}
	if exec.Command("pkg-config", "--exists", "webkit2gtk-4.1").Run() == nil {
		return addBuildTag(args, "webkit2_41"), nil
	}
	return nil, fmt.Errorf("WebKitGTK development files are missing; install libwebkit2gtk-4.1-dev (or your distribution's equivalent)")
}

func targetsLinux(args []string) bool {
	platform := runtime.GOOS + "/" + runtime.GOARCH
	for index, arg := range args {
		switch {
		case arg == "-platform" && index+1 < len(args):
			platform = args[index+1]
		case strings.HasPrefix(arg, "-platform="):
			platform = strings.TrimPrefix(arg, "-platform=")
		}
	}
	for _, target := range strings.Split(platform, ",") {
		if strings.HasPrefix(strings.TrimSpace(target), "linux/") {
			return true
		}
	}
	return false
}

func addBuildTag(args []string, tag string) []string {
	result := append([]string(nil), args...)
	for index, arg := range result {
		switch {
		case arg == "-tags" && index+1 < len(result):
			result[index+1] = mergeBuildTag(result[index+1], tag)
			return result
		case strings.HasPrefix(arg, "-tags="):
			result[index] = "-tags=" + mergeBuildTag(strings.TrimPrefix(arg, "-tags="), tag)
			return result
		}
	}
	return append(result, "-tags", tag)
}

func mergeBuildTag(tags, tag string) string {
	for _, current := range strings.FieldsFunc(tags, func(character rune) bool { return character == ',' || character == ' ' }) {
		if current == tag {
			return tags
		}
	}
	if strings.TrimSpace(tags) == "" {
		return tag
	}
	return tags + "," + tag
}

func parseBoolEnv(name string) (bool, error) {
	switch strings.ToLower(strings.TrimSpace(os.Getenv(name))) {
	case "", "0", "false", "no", "off":
		return false, nil
	case "1", "true", "yes", "on":
		return true, nil
	default:
		return false, fmt.Errorf("%s must be true or false", name)
	}
}
