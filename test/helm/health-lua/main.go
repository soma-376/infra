package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"time"

	lua "github.com/yuin/gopher-lua"
)

// Argo와 같은 gopher-lua에서 표준 library 없이 실제 health.lua를 실행한다.
// 네트워크·Kubernetes 연결이나 fixture 밖 파일 조회는 수행하지 않는다.
func value(state *lua.LState, input any) lua.LValue {
	switch item := input.(type) {
	case nil:
		return lua.LNil
	case bool:
		return lua.LBool(item)
	case float64:
		return lua.LNumber(item)
	case string:
		return lua.LString(item)
	case []any:
		result := state.NewTable()
		for _, entry := range item {
			result.Append(value(state, entry))
		}
		return result
	case map[string]any:
		result := state.NewTable()
		for key, entry := range item {
			result.RawSetString(key, value(state, entry))
		}
		return result
	default:
		panic("지원하지 않는 JSON 값")
	}
}

func run() error {
	var input struct {
		Script string `json:"script"`
		Object any    `json:"object"`
	}
	if err := json.NewDecoder(os.Stdin).Decode(&input); err != nil {
		return err
	}
	state := lua.NewState(lua.Options{SkipOpenLibs: true})
	defer state.Close()
	lua.OpenBase(state)
	for _, name := range []string{"dofile", "loadfile", "load", "loadstring", "require", "collectgarbage"} {
		state.SetGlobal(name, lua.LNil)
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	state.SetContext(ctx)
	state.SetGlobal("obj", value(state, input.Object))
	if err := state.DoString(input.Script); err != nil {
		return err
	}
	result, ok := state.Get(-1).(*lua.LTable)
	if !ok {
		return fmt.Errorf("health 결과는 table이어야 한다")
	}
	return json.NewEncoder(os.Stdout).Encode(map[string]string{"status": result.RawGetString("status").String(), "message": result.RawGetString("message").String()})
}

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
