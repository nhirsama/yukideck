package messenger

import (
	"context"
	"fmt"
	"sort"
	"strings"
	"sync"
)

type CommandHandler func(ctx context.Context, ev *IncomingEvent) (*Message, error)

type CommandSpec struct {
	Command     string // lowercase without leading '/', e.g. "help", "cron"
	Usage       string // e.g. "/cron list"
	Description string
	ModuleID    string
	Handler     CommandHandler
}

type MediaHandlerSpec struct {
	MediaType   string // "image" | "file"
	ModuleID    string
	Description string
	Handler     CommandHandler
}

// CommandBus decouples inbound channels from business modules (M channels + N modules).
type CommandBus struct {
	mu       sync.RWMutex
	commands map[string]CommandSpec
	media    map[string]MediaHandlerSpec
}

func NewCommandBus() *CommandBus {
	b := &CommandBus{
		commands: make(map[string]CommandSpec),
		media:    make(map[string]MediaHandlerSpec),
	}
	b.RegisterCommand(CommandSpec{
		Command:     "help",
		Usage:       "/help",
		Description: "查看所有已启用的机器人指令与能力",
		ModuleID:    "core",
		Handler:     b.handleHelp,
	})
	b.RegisterCommand(CommandSpec{
		Command:     "ping",
		Usage:       "/ping",
		Description: "检查 YukiDeck 双向通信状态",
		ModuleID:    "core",
		Handler: func(_ context.Context, _ *IncomingEvent) (*Message, error) {
			return &Message{Content: "pong — YukiDeck 在线"}, nil
		},
	})
	return b
}

func (b *CommandBus) RegisterCommand(spec CommandSpec) {
	key := strings.ToLower(strings.TrimPrefix(strings.TrimSpace(spec.Command), "/"))
	if key == "" || spec.Handler == nil {
		return
	}
	spec.Command = key
	b.mu.Lock()
	defer b.mu.Unlock()
	b.commands[key] = spec
}

func (b *CommandBus) RegisterMediaHandler(spec MediaHandlerSpec) {
	key := strings.ToLower(strings.TrimSpace(spec.MediaType))
	if key == "" || spec.Handler == nil {
		return
	}
	spec.MediaType = key
	b.mu.Lock()
	defer b.mu.Unlock()
	b.media[key] = spec
}

func (b *CommandBus) Dispatch(ctx context.Context, ev *IncomingEvent) (*Message, error) {
	if ev == nil {
		return nil, nil
	}

	b.mu.RLock()
	if ev.Command != "" {
		spec, ok := b.commands[strings.ToLower(ev.Command)]
		b.mu.RUnlock()
		if !ok {
			return &Message{
				Content: fmt.Sprintf("未知指令 /%s，发送 /help 查看可用指令。", ev.Command),
			}, nil
		}
		return spec.Handler(ctx, ev)
	}

	if len(ev.Attachments) > 0 {
		mediaType := strings.ToLower(ev.Attachments[0].Type)
		spec, ok := b.media[mediaType]
		b.mu.RUnlock()
		if ok {
			return spec.Handler(ctx, ev)
		}
		return &Message{Content: "当前暂无模块处理该类型附件，发送 /help 查看支持的能力。"}, nil
	}
	b.mu.RUnlock()

	return &Message{Content: "未识别为指令，发送 /help 查看可用指令。"}, nil
}

func (b *CommandBus) handleHelp(_ context.Context, _ *IncomingEvent) (*Message, error) {
	b.mu.RLock()
	cmds := make([]CommandSpec, 0, len(b.commands))
	for _, c := range b.commands {
		cmds = append(cmds, c)
	}
	medias := make([]MediaHandlerSpec, 0, len(b.media))
	for _, m := range b.media {
		medias = append(medias, m)
	}
	b.mu.RUnlock()

	sort.Slice(cmds, func(i, j int) bool { return cmds[i].Command < cmds[j].Command })
	sort.Slice(medias, func(i, j int) bool { return medias[i].MediaType < medias[j].MediaType })

	var sb strings.Builder
	sb.WriteString("可用指令：\n")
	for _, c := range cmds {
		usage := c.Usage
		if usage == "" {
			usage = "/" + c.Command
		}
		sb.WriteString(fmt.Sprintf("• %s — %s\n", usage, c.Description))
	}
	if len(medias) > 0 {
		sb.WriteString("\n支持直接发送的媒体：\n")
		for _, m := range medias {
			sb.WriteString(fmt.Sprintf("• [%s] %s\n", m.MediaType, m.Description))
		}
	}
	return &Message{Title: "YukiDeck 帮助", Content: strings.TrimSpace(sb.String())}, nil
}

// ParseSlashCommand extracts "/cmd@bot arg1 arg2" into ("cmd", "arg1 arg2").
func ParseSlashCommand(text string) (string, string) {
	trimmed := strings.TrimSpace(text)
	if !strings.HasPrefix(trimmed, "/") {
		return "", ""
	}
	parts := strings.SplitN(trimmed[1:], " ", 2)
	cmd := parts[0]
	if atIdx := strings.IndexByte(cmd, '@'); atIdx > 0 {
		cmd = cmd[:atIdx]
	}
	args := ""
	if len(parts) == 2 {
		args = strings.TrimSpace(parts[1])
	}
	return strings.ToLower(strings.TrimSpace(cmd)), args
}
