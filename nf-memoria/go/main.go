// resolve-memory-folder, helper for the /nf-memoria skill.
// Resolves the target memory folder for the current session's project via
// a 5-step cascade (env, project settings, user settings, binary default).
//
// Cascade (first match wins):
//  1. $CLAUDE_COWORK_MEMORY_PATH_OVERRIDE in current env
//  2. <toplevel>/.claude/settings.local.json -> .env.CLAUDE_COWORK_MEMORY_PATH_OVERRIDE
//  3. <toplevel>/.claude/settings.local.json -> .autoMemoryDirectory
//  4. $HOME/.claude/settings.json -> .autoMemoryDirectory
//  5. Binary default: $HOME/.claude/projects/<sanitized-pwd>/memory/
//
// Output (stdout): two lines
//
//	path=<absolute-resolved-path>
//	source=<env|local-env|local-auto|user|bindef>
//
// Exit codes: 0 ok, 2 recursive-memory conflict, 4 mkdir failed.
package main

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

const help = `Resolve the target memory folder for the /nf-memoria skill.

Cascade (first match wins):
  1. $CLAUDE_COWORK_MEMORY_PATH_OVERRIDE in current env
  2. <toplevel>/.claude/settings.local.json -> .env.CLAUDE_COWORK_MEMORY_PATH_OVERRIDE
  3. <toplevel>/.claude/settings.local.json -> .autoMemoryDirectory
  4. $HOME/.claude/settings.json -> .autoMemoryDirectory
  5. Binary default: $HOME/.claude/projects/<sanitized-pwd>/memory/

Output:
  path=<absolute>
  source=<env|local-env|local-auto|user|bindef>

Exit codes:
  0 - resolved + mkdir ok
  2 - recursive-memory conflict
  4 - mkdir failed
`

func home() string {
	if h, err := os.UserHomeDir(); err == nil {
		return h
	}
	return os.Getenv("HOME")
}

func expandTilde(p, h string) string {
	if p == "" {
		return p
	}
	if p == "~" {
		return h
	}
	if strings.HasPrefix(p, "~/") {
		return h + p[1:]
	}
	return p
}

// readJSONField reads file as JSON and walks dot-separated path. Returns ""
// when the file is missing, malformed, or the path resolves to nil/empty.
func readJSONField(file, path string) string {
	data, err := os.ReadFile(file)
	if err != nil {
		return ""
	}
	var v any
	if err := json.Unmarshal(data, &v); err != nil {
		return ""
	}
	for _, seg := range strings.Split(path, ".") {
		m, ok := v.(map[string]any)
		if !ok {
			return ""
		}
		v = m[seg]
		if v == nil {
			return ""
		}
	}
	switch x := v.(type) {
	case string:
		return x
	case float64:
		return fmt.Sprintf("%v", x)
	case bool:
		return fmt.Sprintf("%v", x)
	default:
		return ""
	}
}

func gitToplevel() (string, bool) {
	out, err := exec.Command("git", "rev-parse", "--show-toplevel").Output()
	if err != nil {
		return "", false
	}
	s := strings.TrimSpace(string(out))
	return s, s != ""
}

func main() {
	for _, a := range os.Args[1:] {
		switch a {
		case "-h", "--help":
			fmt.Println(help)
			return
		default:
			fmt.Fprintf(os.Stderr, "resolve-memory-folder: unknown arg: %s\n", a)
		}
	}

	h := home()
	var toplevel string
	if top, ok := gitToplevel(); ok {
		toplevel = top
	} else {
		cwd, _ := os.Getwd()
		toplevel = cwd
	}

	localSettings := toplevel + "/.claude/settings.local.json"
	userSettings := h + "/.claude/settings.json"

	resolved, source := "", ""

	// 1: env
	if v := os.Getenv("CLAUDE_COWORK_MEMORY_PATH_OVERRIDE"); v != "" {
		resolved, source = v, "env"
	}

	// 2: local settings env override
	if resolved == "" {
		if v := readJSONField(localSettings, "env.CLAUDE_COWORK_MEMORY_PATH_OVERRIDE"); v != "" {
			resolved, source = v, "local-env"
		}
	}

	// 3: local settings autoMemoryDirectory
	if resolved == "" {
		if v := readJSONField(localSettings, "autoMemoryDirectory"); v != "" {
			resolved, source = v, "local-auto"
		}
	}

	// 4: user settings autoMemoryDirectory
	if resolved == "" {
		if v := readJSONField(userSettings, "autoMemoryDirectory"); v != "" {
			resolved, source = v, "user"
		}
	}

	// 5: binary default. Match the CC binary's cwd resolution which follows
	// symlinks (the binary itself writes auto-memory keyed by the resolved
	// path, so we must colocate with it).
	if resolved == "" {
		base, _ := os.Getwd()
		if real, err := filepath.EvalSymlinks(base); err == nil {
			base = real
		}
		sanitized := strings.NewReplacer("/", "-", ".", "-").Replace(base)
		resolved = h + "/.claude/projects/" + sanitized + "/memory/"
		source = "bindef"
	}

	resolved = expandTilde(resolved, h)

	// Recursive-memory safeguard. Allow when toplevel itself is under
	// ~/.claude (a memory submodule or repo may live there).
	if strings.HasPrefix(resolved+"/", toplevel+"/") && !strings.HasPrefix(toplevel, h+"/.claude") {
		fmt.Fprintf(os.Stderr, "resolve-memory-folder: refusing to write memory inside repo toplevel (%s)\n", toplevel)
		fmt.Fprintf(os.Stderr, "  resolved=%s source=%s\n", resolved, source)
		os.Exit(2)
	}

	if err := os.MkdirAll(resolved, 0o755); err != nil {
		fmt.Fprintf(os.Stderr, "resolve-memory-folder: mkdir -p failed for %s\n", resolved)
		os.Exit(4)
	}

	fmt.Printf("path=%s\n", resolved)
	fmt.Printf("source=%s\n", source)
}
